import { createRslib } from '@rslib/core';
import { rspack } from '@rspack/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RslibVirtualModule {
  readonly name: string;
  readonly source: string;
}

export interface RslibEntry {
  readonly name: string;
  readonly outputRelativePath: string;
  readonly source: string;
  readonly virtualModules?: readonly RslibVirtualModule[];
  readonly virtualSource?: string;
}

type RslibInstance = Awaited<ReturnType<typeof createRslib>>;

interface RslibDependencies {
  readonly createRslib?: (options: Parameters<typeof createRslib>[0]) => Promise<Pick<RslibInstance, 'build' | 'inspectConfig'>>;
}

const entryAnchor = fileURLToPath(import.meta.url);

const assertVirtualConfig = (
  entries: readonly RslibEntry[],
  configs: readonly { readonly output?: { readonly asyncChunks?: boolean; readonly path?: string }; readonly plugins?: readonly unknown[]; readonly target?: false | string | readonly string[] }[],
  outputRoot: string,
): void => {
  const virtualEntries = entries.filter(
    (entry) => entry.virtualSource !== undefined || (entry.virtualModules?.length ?? 0) > 0,
  );
  if (virtualEntries.length === 0) return;
  if (configs.length !== entries.length) {
    throw new Error('Rslib did not resolve one environment for every generated executable.');
  }
  for (const config of configs) {
    const target = Array.isArray(config.target) ? config.target : [config.target];
    if (config.output?.asyncChunks !== false || config.output.path !== outputRoot || !target.some((value) => value === 'node')) {
      throw new Error('Rslib resolved an invalid generated executable configuration.');
    }
    const hasVirtualModule = config.plugins?.some(
      (plugin) => plugin instanceof rspack.experiments.VirtualModulesPlugin,
    );
    if (!hasVirtualModule) {
      throw new Error('Rslib resolved a generated executable environment without its virtual module.');
    }
  }
};

export const buildWithRslib = async (options: {
  readonly cwd: string;
  readonly entries: readonly RslibEntry[];
  readonly outputRoot: string;
}, dependencies: RslibDependencies = {}): Promise<void> => {
  if (options.entries.length === 0) {
    return;
  }

  const rslib = await (dependencies.createRslib ?? createRslib)({
    cwd: options.cwd,
    config: {
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
          performance: { chunkSplit: { strategy: 'all-in-one' } },
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
          ...(!hasVirtualModules
            ? {}
            : {
                tools: {
                  rspack: (config) => {
                    config.output.asyncChunks = false;
                    config.resolve.alias = {
                      ...config.resolve.alias,
                      ...Object.fromEntries(virtualModules.map((module) => [module.name, module.path])),
                    };
                    config.plugins.push(new rspack.experiments.VirtualModulesPlugin({
                      ...(virtualSource === undefined ? {} : { [entryAnchor]: virtualSource }),
                      ...Object.fromEntries(virtualModules.map((module) => [module.path, module.source])),
                    }));
                  },
                },
              }),
        };
      }),
    },
  });

  const inspection = await rslib.inspectConfig();
  assertVirtualConfig(options.entries, inspection.origin.bundlerConfigs, options.outputRoot);
  let result: Awaited<ReturnType<typeof rslib.build>> | undefined;
  try {
    result = await rslib.build();
  } finally {
    await result?.close();
  }
};
