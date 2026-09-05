import type { Rspack } from '@rslib/core';

import { isRecord } from '../core/strict-json.ts';
import type { CompilationEvidence, CompilationExternal, CompilationModule } from './compile-result.ts';

const pluginName = 'agent-bundle:dependency-audit';

const externalIdentifierPrefix = /^external (\S+) (?=["[{])/u;

/** Length of the JSON string, array, or object that opens `text`, or -1 when it never closes. */
const jsonPrefixLength = (text: string): number => {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') {
        inString = false;
        if (depth === 0) return index + 1;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
};

/**
 * `external <type> <request as JSON>`, then optional space-separated import
 * attributes (`{"type":"json"}`) or phase (`phase=defer`), then optional
 * `|`-separated layer and issuer segments. The JSON request is what the emitted
 * code loads at run time: a string; an array whose first element is the module
 * and whose rest are property paths; or a per-type map (`{"module":"lp"}`) read
 * at the resolved type. An object-map external such as `{ 'left-pad': 'lp' }`
 * names `"lp"` here and `left-pad` in `userRequest`.
 */
const runtimeRequest = (module: Rspack.ExternalModule): { readonly externalType: string; readonly request: string } => {
  const identifier = module.identifier();
  const unexpected = (): Error => new Error(`Rspack ExternalModule has an unexpected identifier: ${JSON.stringify(identifier)}.`);
  const prefix = externalIdentifierPrefix.exec(identifier);
  if (prefix === null) throw unexpected();
  const externalType = prefix[1]!;
  const json = identifier.slice(prefix[0].length);
  const length = jsonPrefixLength(json);
  const rest = json.slice(length);
  if (length === -1 || (rest !== '' && !rest.startsWith('|') && !rest.startsWith(' '))) throw unexpected();
  const parsed: unknown = JSON.parse(json.slice(0, length));
  const byType = isRecord(parsed) ? parsed[externalType] : parsed;
  const request = Array.isArray(byType) ? byType[0] : byType;
  if (typeof request !== 'string') throw unexpected();
  return { externalType, request };
};

const moduleResource = (module: Rspack.Module | null | undefined): string | undefined =>
  module?.nameForCondition() ?? module?.identifier();

const collectExternals = (compilation: Rspack.Compilation): readonly CompilationExternal[] => {
  const { ExternalModule } = compilation.compiler.rspack;
  const byRequest = new Map<string, {
    readonly externalType: string;
    readonly issuers: Set<string>;
    readonly request: string;
    readonly userRequest: string;
  }>();
  for (const module of compilation.modules) {
    if (!(module instanceof ExternalModule)) continue;
    const { externalType, request } = runtimeRequest(module);
    const key = [externalType, request, module.userRequest].join('\u0000');
    const record = byRequest.get(key) ?? {
      externalType,
      issuers: new Set<string>(),
      request,
      userRequest: module.userRequest,
    };
    for (const connection of compilation.moduleGraph.getIncomingConnections(module)) {
      const issuer = moduleResource(connection.originModule);
      if (issuer !== undefined) record.issuers.add(issuer);
    }
    byRequest.set(key, record);
  }
  return Object.freeze([...byRequest.values()]
    .map(({ externalType, issuers, request, userRequest }) => Object.freeze({
      externalType,
      issuers: Object.freeze([...issuers].sort()),
      request,
      userRequest,
    }))
    .sort((left, right) =>
      left.request.localeCompare(right.request)
      || left.userRequest.localeCompare(right.userRequest)
      || left.externalType.localeCompare(right.externalType)));
};

const collectModules = (compilation: Rspack.Compilation): readonly CompilationModule[] => {
  const { NormalModule } = compilation.compiler.rspack;
  const modules: CompilationModule[] = [];
  for (const module of compilation.modules) {
    if (!(module instanceof NormalModule)) continue;
    const resource = module.nameForCondition();
    modules.push(Object.freeze({ identifier: module.identifier(), ...(resource === undefined ? {} : { resource }) }));
  }
  return Object.freeze(modules.sort((left, right) => left.identifier.localeCompare(right.identifier)));
};

/**
 * Records what one compilation resolved — externals with their issuers and
 * bundled modules — once the module graph is final and before any asset is
 * emitted. Module classes come from the compiler's own Rspack instance, so the
 * plugin judges an Rslib and an Rsbuild compilation alike.
 */
export class ArtifactDependencyAuditPlugin {
  readonly #record: (evidence: CompilationEvidence) => void;

  constructor(record: (evidence: CompilationEvidence) => void) {
    this.#record = record;
  }

  apply(compiler: Rspack.Compiler): void {
    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      compilation.hooks.afterOptimizeModules.tap(pluginName, () => {
        const compilerName = compilation.compiler.name;
        if (compilerName === undefined) {
          throw new Error('Rspack compilation has no compiler name; Rslib must name each lib with its entry id.');
        }
        this.#record(Object.freeze({
          compiler: compilerName,
          externals: collectExternals(compilation),
          modules: collectModules(compilation),
        }));
      });
    });
  }
}
