import { defineConfig } from '@rslib/core';
import { pluginPublint } from 'rsbuild-plugin-publint';

export default defineConfig({
  lib: [
    {
      bundle: true,
      dts: true,
      format: 'esm',
      syntax: 'es2022',
      // One lib, one module graph: every public entry is compiled together,
      // so a module two entries share is emitted once, in a shared chunk both
      // import (`dist/<id>.js`), and class identity holds across subpaths —
      // `instanceof AgentStateError` is true whether the error came through
      // `./state`, `./state/sqlite`, `./mount`, or `./lineage`. Entry graphs
      // still stay lean: a module only one entry reaches is emitted in that
      // entry's own chunk, so `node:sqlite` loads only through `./state/sqlite`,
      // the package root carries no kernel or ledger code, and `./plugin`
      // stays Effect-free. tests/state-packaging.test.ts holds those
      // boundaries against the workspace dist; tests/packed-entry-identity.test.ts
      // holds them against the installed release tarball.
      source: {
        entry: {
          'flight/server': './src/flight/server.ts',
          index: './src/index.ts',
          lineage: './src/lineage/index.ts',
          mount: './src/mount/index.ts',
          notices: './src/notices/index.ts',
          'notices/inbox-route': './src/notices/inbox-route.ts',
          plugin: './src/plugin.ts',
          state: './src/state/index.ts',
          'state/sqlite': './src/state/sqlite.ts',
        },
      },
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
    tsconfigPath: './tsconfig.build.json',
  },
});
