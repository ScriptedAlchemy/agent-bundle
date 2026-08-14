import { createRslib } from '@rslib/core';
import { rspack } from '@rspack/core';
import { fileURLToPath } from 'node:url';

export interface RslibEntry {
  readonly name: string;
  readonly outputRelativePath: string;
  readonly source: string;
  readonly virtualSource?: string;
}

const entryAnchor = fileURLToPath(import.meta.url);

const assertVirtualHookConfig = (
  entries: readonly RslibEntry[],
  configs: readonly { readonly output?: { readonly asyncChunks?: boolean; readonly path?: string }; readonly plugins?: readonly unknown[]; readonly target?: string | readonly string[] }[],
  outputRoot: string,
): void => {
  const virtualEntries = entries.filter((entry) => entry.virtualSource !== undefined);
  if (virtualEntries.length === 0) return;
  if (configs.length !== entries.length) {
    throw new Error('Rslib did not resolve one environment for every generated executable.');
  }
  for (const config of configs) {
    const target = Array.isArray(config.target) ? config.target : [config.target];
    if (config.output?.asyncChunks !== false || config.output.path !== outputRoot || !target.includes('node')) {
      throw new Error('Rslib resolved an invalid generated-hook executable configuration.');
    }
    const hasVirtualModule = config.plugins?.some(
      (plugin) => plugin instanceof rspack.experiments.VirtualModulesPlugin,
    );
    if (!hasVirtualModule) {
      throw new Error('Rslib resolved a generated-hook environment without its virtual module.');
    }
  }
};

export const buildWithRslib = async (options: {
  readonly cwd: string;
  readonly entries: readonly RslibEntry[];
  readonly outputRoot: string;
}): Promise<void> => {
  if (options.entries.length === 0) {
    return;
  }

  const rslib = await createRslib({
    cwd: options.cwd,
    config: {
      lib: options.entries.map((entry) => ({
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
              [entry.name]: entry.virtualSource === undefined ? entry.source : entryAnchor,
            },
          },
          ...(entry.virtualSource === undefined
            ? {}
            : {
                tools: {
                  rspack: (config) => {
                    config.output.asyncChunks = false;
                    config.plugins.push(new rspack.experiments.VirtualModulesPlugin({
                      [entryAnchor]: entry.virtualSource,
                    }));
                  },
                },
              }),
        })),
    },
  });

  const inspection = await rslib.inspectConfig();
  assertVirtualHookConfig(options.entries, inspection.origin.bundlerConfigs, options.outputRoot);
  let result: Awaited<ReturnType<typeof rslib.build>> | undefined;
  try {
    result = await rslib.build();
  } finally {
    await result?.close();
  }
};
