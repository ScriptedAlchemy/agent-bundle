// Rslib re-exports its own rspack; installing @rspack/core separately risks
// version conflicts (https://rslib.rs/api/javascript-api/core).
import { mergeRsbuildConfig } from '@rsbuild/core';
import { createRslib, rspack, type LibConfig } from '@rslib/core';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isErrno } from '../core/errors.ts';
import type { AgentBundleToolsConfig } from '../core/types.ts';
import { collectBundledOutputEvidence, type BundledOutputEvidence } from './provenance.ts';

export interface RslibVirtualModule {
  readonly name: string;
  readonly source: string;
}

export interface RslibEntry {
  /** Module specifiers aliased onto existing on-disk modules (e.g. the mcp-entry runtime shell). */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Raw JS banner prepended to the emitted bundle (e.g. a bin shebang). */
  readonly banner?: string;
  /** Emit type declarations for this entry's program. Defaults to false. */
  readonly dts?: boolean;
  readonly name: string;
  readonly outputRelativePath: string;
  readonly source: string;
  readonly sourceInputs: readonly string[];
  /** TypeScript project driving declaration generation and compiler options. */
  readonly tsconfigPath?: string;
  readonly virtualModules?: readonly RslibVirtualModule[];
  readonly virtualSource?: string;
}

type RslibInstance = Awaited<ReturnType<typeof createRslib>>;
type RslibLibConfig = LibConfig;

interface RslibDependencies {
  readonly createRslib?: (options: Parameters<typeof createRslib>[0]) => Promise<Pick<RslibInstance, 'build' | 'inspectConfig'>>;
}

const entryAnchor = fileURLToPath(import.meta.url);

const declaredDependencyRoots = async (cwd: string): Promise<readonly string[]> => {
  let bytes: string;
  try {
    bytes = await readFile(resolve(cwd, 'package.json'), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    throw error;
  }
  const manifest = JSON.parse(bytes) as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[field];
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  const roots = await Promise.all([...names].map(async (name) => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) return undefined;
    try {
      return await realpath(resolve(cwd, 'node_modules', ...name.split('/')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }));
  return Object.freeze(roots.filter((root): root is string => root !== undefined));
};

const assertExecutableConfig = (
  entries: readonly RslibEntry[],
  configs: readonly { readonly output?: { readonly asyncChunks?: boolean; readonly path?: string }; readonly plugins?: readonly unknown[]; readonly target?: false | string | readonly string[] }[],
  outputRoot: string,
): void => {
  if (configs.length !== entries.length) {
    throw new Error('Rslib did not resolve one environment for every generated executable.');
  }
  for (const [index, config] of configs.entries()) {
    const entry = entries[index]!;
    const target = Array.isArray(config.target) ? config.target : [config.target];
    if (config.output?.asyncChunks !== false || config.output.path !== outputRoot || !target.some((value) => value === 'node')) {
      throw new Error('Rslib resolved an invalid generated executable configuration.');
    }
    const entryHasVirtualModules =
      entry.virtualSource !== undefined || (entry.virtualModules?.length ?? 0) > 0;
    if (entryHasVirtualModules) {
      const hasVirtualModule = config.plugins?.some(
        (plugin) => plugin instanceof rspack.experiments.VirtualModulesPlugin,
      );
      if (!hasVirtualModule) {
        throw new Error('Rslib resolved a generated executable environment without its virtual module.');
      }
    }
  }
};

export const buildWithRslib = async (options: {
  readonly cwd: string;
  readonly entries: readonly RslibEntry[];
  /** Extra module roots excluded from authored-source evidence (e.g. the aliased runtime shell). */
  readonly ignoredSourcePaths?: readonly string[];
  /** 'error' lets declaration-generation failures reach the consumer's terminal. */
  readonly logLevel?: 'error' | 'silent';
  readonly outputRoot: string;
  /** The consumer escape hatch, merged last-but-bounded into every synthesized entry. */
  readonly tools?: AgentBundleToolsConfig;
}, dependencies: RslibDependencies = {}): Promise<readonly BundledOutputEvidence[]> => {
  if (options.entries.length === 0) {
    return Object.freeze([]);
  }
  const dependencyRoots = await declaredDependencyRoots(options.cwd);

  const rslib = await (dependencies.createRslib ?? createRslib)({
    cwd: options.cwd,
    config: {
      logLevel: options.logLevel ?? 'silent',
      lib: options.entries.map((entry) => {
        const virtualSource = entry.virtualSource;
        const virtualModules = (entry.virtualModules ?? []).map((module, index) => ({
          ...module,
          path: resolve(options.outputRoot, '.agent-bundle-virtual', `${entry.name}-${index}.mjs`),
        }));
        const hasVirtualModules = virtualSource !== undefined || virtualModules.length > 0;
        const aliases = entry.aliases ?? {};
        const enforceInvariants = (config: {
          output: { asyncChunks?: boolean };
          plugins: unknown[];
          resolve: { alias?: Record<string, unknown> };
        }): void => {
          config.output.asyncChunks = false;
          if (hasVirtualModules || Object.keys(aliases).length > 0) {
            config.resolve.alias = {
              ...config.resolve.alias,
              ...aliases,
              ...Object.fromEntries(virtualModules.map((module) => [module.name, module.path])),
            };
          }
          if (hasVirtualModules) {
            config.plugins.push(new rspack.experiments.VirtualModulesPlugin({
              ...(virtualSource === undefined ? {} : { [entryAnchor]: virtualSource }),
              ...Object.fromEntries(virtualModules.map((module) => [module.path, module.source])),
            }));
          }
        };
        const profile: RslibLibConfig = {
          id: `agent-bundle-${entry.name}`,
          autoExternal: false,
          ...(entry.banner === undefined ? {} : { banner: { js: entry.banner } }),
          bundle: true,
          dts: entry.dts === true,
          format: 'esm',
          // Copied projects can share one node_modules tree, so a cache keyed
          // by this stable library id would give concurrent builds one lock.
          performance: {
            buildCache: false,
          },
          // Rsbuild 2.x deprecated performance.chunkSplit 'all-in-one'; the
          // documented migration is top-level splitChunks: false, which also
          // guards against the node-target splitting default added in v2.2.
          splitChunks: false,
          syntax: 'es2022',
          output: {
            cleanDistPath: false,
            distPath: { root: options.outputRoot },
            filename: { js: entry.outputRelativePath },
            filenameHash: false,
            legalComments: 'none',
            minify: false,
            sourceMap: false,
            target: 'node',
          },
          source: {
            entry: {
              [entry.name]: virtualSource === undefined ? entry.source : entryAnchor,
            },
            ...(entry.tsconfigPath === undefined ? {} : { tsconfigPath: entry.tsconfigPath }),
          },
        };
        // The escape hatch merges over the synthesized profile (Rslib's
        // "raw user config highest" priority); the invariant enforcer hook is
        // appended last, and the post-resolution assertions bound the hatch.
        return mergeRsbuildConfig(
          profile as never,
          ...(options.tools?.rsbuild === undefined ? [] : [options.tools.rsbuild as never]),
          ...(options.tools?.rspack === undefined ? [] : [{ tools: { rspack: options.tools.rspack } } as never]),
          { tools: { rspack: enforceInvariants } } as never,
        ) as RslibLibConfig;
      }),
    },
  });

  const inspection = await rslib.inspectConfig();
  assertExecutableConfig(options.entries, inspection.origin.bundlerConfigs, options.outputRoot);
  let result: Awaited<ReturnType<typeof rslib.build>> | undefined;
  try {
    result = await rslib.build();
    return collectBundledOutputEvidence({
      expectedAssets: options.entries.map((entry) => ({
        path: entry.outputRelativePath,
        sourceInputs: entry.sourceInputs,
      })),
      ignoredSourcePaths: [
        entryAnchor,
        resolve(options.outputRoot, '.agent-bundle-virtual'),
        ...(options.ignoredSourcePaths ?? []),
        ...dependencyRoots,
      ],
      projectRoot: options.cwd,
      stats: result.stats,
    });
  } finally {
    await result?.close();
  }
};
