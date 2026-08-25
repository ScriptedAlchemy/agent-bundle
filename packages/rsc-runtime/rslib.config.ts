import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      bundle: true,
      dts: true,
      format: 'esm',
      syntax: 'es2022',
    },
  ],
  output: {
    cleanDistPath: true,
    filenameHash: false,
    target: 'node',
  },
  root: import.meta.dirname,
  source: {
    entry: {
      index: './src/index.ts',
    },
    tsconfigPath: './tsconfig.build.json',
  },
});
