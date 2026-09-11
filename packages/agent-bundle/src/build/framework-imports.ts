import type { Rspack } from '@rslib/core';
import { resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { isRecord } from '../core/strict-json.ts';

const compilerEntries = ['.', './api', './config', './eval', './rstest', './test', './test/browser'];
const compilerRequests = new Set(compilerEntries.map((entry) => entry === '.' ? 'agent-bundle' : `agent-bundle/${entry.slice(2)}`));
const targets = (value: unknown): string[] => typeof value === 'string'
  ? [value]
  : Array.isArray(value) ? value.flatMap(targets) : isRecord(value) ? Object.values(value).flatMap(targets) : [];

/** Enforces the runtime boundary on imports that survive the configured transform. */
export class FrameworkImportBoundaryPlugin {
  readonly #report: (diagnostic: Diagnostic) => void;

  constructor(report: (diagnostic: Diagnostic) => void) {
    this.#report = report;
  }

  apply(compiler: Rspack.Compiler): void {
    const reject = (request: string, issuer: string): never => {
      const diagnostic: Diagnostic = {
        code: 'AB4837',
        severity: 'error',
        sourcePath: issuer,
        message: `Module ${issuer} imports ${JSON.stringify(request)}; a self-contained executable cannot bundle the framework compiler.`,
        recovery: 'Keep framework calls in a host process: expose the App with web.apps and open it with <plugin> web; use import type for framework types; otherwise move the call into a package.json script or a hand-written .mjs run from the checkout.',
      };
      this.#report(diagnostic);
      throw new Error(diagnostic.message);
    };
    compiler.hooks.normalModuleFactory.tap('agent-bundle:framework-imports', (factory) => {
      factory.hooks.beforeResolve.tap('agent-bundle:framework-imports', (data) => {
        if (compilerRequests.has(data.request)) reject(data.request, data.contextInfo.issuer);
      });
      const identities = new Map<string, Promise<string | undefined>>();
      factory.hooks.afterResolve.tapPromise('agent-bundle:framework-imports', async (data) => {
        const resource = data.createData?.resource;
        if (resource === undefined) return;
        let identity = identities.get(resource);
        if (identity === undefined) {
          identity = new Promise((accept, fail) => {
            // Ask the compiler resolver for package identity, including aliased requests.
            factory.getResolver('normal', {}).resolve({}, data.context, resource, {}, (error, _path, resolved) => {
              if (error != null) { fail(error); return; }
              // Rspack supplies the parsed manifest despite its string declaration.
              const manifest: unknown = resolved?.descriptionFileData;
              if (!isRecord(manifest) || manifest.name !== 'agent-bundle' || !isRecord(manifest.exports) || resolved?.descriptionFilePath === undefined) {
                accept(undefined);
                return;
              }
              const exports = manifest.exports;
              const root = resolved.descriptionFilePath;
              const entry = compilerEntries.find((key) => targets(exports[key]).some((target) => resolve(root, target) === resolved.path));
              accept(entry === undefined ? undefined : entry === '.' ? 'agent-bundle' : `agent-bundle/${entry.slice(2)}`);
            });
          });
          identities.set(resource, identity);
        }
        const entry = await identity;
        if (entry !== undefined) reject(entry, data.contextInfo.issuer);
      });
    });
  }
}
