import { defineConfig } from '@rslib/core';
import { pluginPublint } from 'rsbuild-plugin-publint';

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
      // Notices are optional and reuse the state entry's kernel runtime.
      // Keeping this entry separate means stateless package-root consumers
      // receive no ledger code and the notice entry never loads node:sqlite.
      output: {
        cleanDistPath: false,
        externals: { '../state/index.js': './state.js' },
      },
      source: {
        entry: { notices: './src/notices/index.ts' },
      },
    },
    {
      ...sharedLib,
      // Generated mounting composes the optional state and notice entries but
      // never imports the sqlite driver; durable callers inject that driver.
      output: {
        cleanDistPath: false,
        externals: {
          '../notices/index.js': './notices.js',
          '../state/index.js': './state.js',
        },
      },
      source: {
        entry: { mount: './src/mount/index.ts' },
      },
    },
    {
      ...sharedLib,
      // The generated MCP inbox resource is React-bearing and therefore stays
      // separate from the lean notice ledger entry.
      output: {
        cleanDistPath: false,
        externals: {
          '../index.js': '../index.js',
          './index.js': '../notices.js',
        },
      },
      source: {
        entry: { 'notices/inbox-route': './src/notices/inbox-route.ts' },
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
  // Suggestions stay informational; errors and warnings block publishing.
  plugins: [pluginPublint({ throwOn: 'warning' })],
  root: import.meta.dirname,
  source: {
    tsconfigPath: './tsconfig.build.json',
  },
});
