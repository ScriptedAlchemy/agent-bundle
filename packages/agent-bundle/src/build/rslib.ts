// Rslib re-exports its own rspack; installing @rspack/core separately risks
// version conflicts (https://rslib.rs/api/javascript-api/core).
import { createRslib, rspack } from '@rslib/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectBundledOutputEvidence, type BundledOutputEvidence } from './provenance.ts';

export interface RslibVirtualModule {
  readonly name: string;
  readonly source: string;
}

export interface RslibEntry {
  readonly name: string;
  readonly outputRelativePath: string;
  readonly source: string;
  readonly sourceInputs: readonly string[];
  readonly virtualModules?: readonly RslibVirtualModule[];
  readonly virtualSource?: string;
}

type RslibInstance = Awaited<ReturnType<typeof createRslib>>;

interface RslibDependencies {
  readonly createRslib?: (options: Parameters<typeof createRslib>[0]) => Promise<Pick<RslibInstance, 'build' | 'inspectConfig'>>;
}

const entryAnchor = fileURLToPath(import.meta.url);

const assertExecutableConfig = (
  entries: readonly RslibEntry[],
  configs: readonly { readonly output?: { readonly asyncChunks?: boolean; readonly path?: string }; readonly plugins?: readonly unknown[]; readonly target?: false | string | readonly string[] }[],
  outputRoot: string,
): void => {
  const virtualEntries = entries.filter(
    (entry) => entry.virtualSource !== undefined || (entry.virtualModules?.length ?? 0) > 0,
  );
  if (configs.length !== entries.length) {
    throw new Error('Rslib did not resolve one environment for every generated executable.');
  }
  for (const config of configs) {
    const target = Array.isArray(config.target) ? config.target : [config.target];
    if (config.output?.asyncChunks !== false || config.output.path !== outputRoot || !target.some((value) => value === 'node')) {
      throw new Error('Rslib resolved an invalid generated executable configuration.');
    }
    if (virtualEntries.length > 0) {
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
  readonly outputRoot: string;
}, dependencies: RslibDependencies = {}): Promise<readonly BundledOutputEvidence[]> => {
  if (options.entries.length === 0) {
    return Object.freeze([]);
  }

  const rslib = await (dependencies.createRslib ?? createRslib)({
    cwd: options.cwd,
    config: {
      logLevel: 'silent',
      lib: options.entries.map((entry) => {
        const virtualSource = entry.virtualSource;
        const virtualModules = (entry.virtualModules ?? []).map((module, index) => ({
          ...module,
          path: resolve(options.outputRoot, '.agent-bundle-virtual', `${entry.name}-${index}.mjs`),
        }));
        const hasVirtualModules = virtualSource !== undefined || virtualModules.length > 0;
        return {
          id: `agent-bundle-${entry.name}`,
          autoExternal: false,
          bundle: true,
          dts: false,
          format: 'esm',
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
          },
          tools: {
            rspack: (config) => {
              config.output.asyncChunks = false;
              if (hasVirtualModules) {
                    config.resolve.alias = {
                      ...config.resolve.alias,
                      ...Object.fromEntries(virtualModules.map((module) => [module.name, module.path])),
                    };
                    config.plugins.push(new rspack.experiments.VirtualModulesPlugin({
                      ...(virtualSource === undefined ? {} : { [entryAnchor]: virtualSource }),
                      ...Object.fromEntries(virtualModules.map((module) => [module.path, module.source])),
                    }));
              }
            },
          },
        };
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
      ignoredSourcePaths: [entryAnchor, resolve(options.outputRoot, '.agent-bundle-virtual')],
      projectRoot: options.cwd,
      stats: result.stats,
    });
  } finally {
    await result?.close();
  }
};
