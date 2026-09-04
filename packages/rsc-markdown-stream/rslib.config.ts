import { defineConfig } from '@rslib/core';
import { pluginPublint } from 'rsbuild-plugin-publint';

export default defineConfig({
  lib: [
    {
      bundle: true,
      // The public types are the hand-written `src/index.d.ts`, copied into
      // dist below; the renderer itself is plain ESM, so there is nothing
      // for a declaration emit to derive.
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
