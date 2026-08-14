import { createRslib } from '@rslib/core';

export interface RslibEntry {
  readonly name: string;
  readonly source: string;
}

export const buildWithRslib = async (options: {
  readonly cwd: string;
  readonly entries: readonly RslibEntry[];
  readonly outputRoot: string;
}): Promise<void> => {
  if (options.entries.length === 0) {
    return;
  }

  const entry = Object.fromEntries(
    options.entries.map(({ name, source }) => [name, source]),
  );
  const rslib = await createRslib({
    cwd: options.cwd,
    config: {
      lib: [
        {
          autoExternal: false,
          bundle: true,
          dts: false,
          format: 'esm',
          syntax: 'es2022',
        },
      ],
      output: {
        cleanDistPath: false,
        distPath: { root: options.outputRoot },
        filename: { js: 'scripts/[name].mjs' },
        filenameHash: false,
        legalComments: 'none',
        minify: false,
        sourceMap: false,
        target: 'node',
      },
      source: { entry },
    },
  });

  await rslib.build();
};
