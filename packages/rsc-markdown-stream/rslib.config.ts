import { defineConfig } from '@rslib/core';
import { pluginPublint } from 'rsbuild-plugin-publint';

export default defineConfig({
  lib: [
    {
      bundle: true,
      // The public types are the hand-written `src/index.d.ts`, copied into
      // dist below; the renderer itself is plain ESM, so there is nothing
      // for a declaration emit to derive. tests/types.ts compiles real calls
      // against those declarations and tests/declarations.test.ts holds their
      // value exports equal to the renderer's, so the copy cannot drift.
      dts: false,
      format: 'esm',
      syntax: 'es2022',
      source: {
        entry: { index: './src/index.js' },
      },
    },
  ],
  output: {
    cleanDistPath: true,
    copy: [{ from: './src/index.d.ts' }],
    filenameHash: false,
    target: 'node',
  },
  // Suggestions stay informational; errors and warnings block publishing.
  plugins: [pluginPublint({ throwOn: 'warning' })],
  root: import.meta.dirname,
});
