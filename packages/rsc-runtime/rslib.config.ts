import { defineConfig } from '@rslib/core';

const sharedLib = {
  bundle: true,
  dts: true,
  format: 'esm',
  syntax: 'es2022',
} as const;

export default defineConfig({
  lib: [
    {
      ...sharedLib,
      source: {
        entry: {
          'flight/server': './src/flight/server.ts',
          index: './src/index.ts',
          plugin: './src/plugin.ts',
          state: './src/state/index.ts',
        },
      },
    },
    {
      ...sharedLib,
      // The sqlite driver is its own entry so `node:sqlite` (and its
      // ExperimentalWarning) never loads for volatile-state or stateless
      // consumers. It imports the state entry's runtime instead of
      // re-bundling the kernel: a duplicated module graph would fork class
      // identity and break `instanceof AgentStateError` across entries.
      output: {
        cleanDistPath: false,
        externals: { './index.js': '../state.js' },
      },
      source: {
        entry: { 'state/sqlite': './src/state/sqlite.ts' },
      },
    },
  ],
  output: {
    cleanDistPath: true,
    filenameHash: false,
    target: 'node',
  },
  root: import.meta.dirname,
  source: {
    tsconfigPath: './tsconfig.build.json',
  },
});
