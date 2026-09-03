import { defineConfig } from '@rslib/core';
import { pluginPublint } from 'rsbuild-plugin-publint';

/**
 * Single self-contained ESM bundle: `@clack/prompts` is a devDependency so
 * Rslib inlines it and the published package has zero runtime dependencies,
 * the same shape `create-rstack` ships (its npm tarball declares no
 * dependencies and bundles the prompt toolkit).
 */
export default defineConfig({
  lib: [
    {
      bundle: true,
      dts: false,
      format: 'esm',
      syntax: 'es2022',
    },
  ],
  output: {
    cleanDistPath: true,
    filenameHash: false,
    target: 'node',
  },
  // Suggestions stay informational; errors and warnings block publishing.
  plugins: [pluginPublint({ throwOn: 'warning' })],
  root: import.meta.dirname,
  source: {
    entry: {
      index: './src/index.ts',
    },
    tsconfigPath: './tsconfig.build.json',
  },
});
