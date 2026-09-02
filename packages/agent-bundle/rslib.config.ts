import { resolve } from 'node:path';

import { defineConfig } from '@rslib/core';
import packageManifest from './package.json' with { type: 'json' };

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
    copy: [
      { from: resolve(import.meta.dirname, '../workbench/dist'), to: 'workbench', info: { minimized: true } },
    ],
    filenameHash: false,
    legalComments: 'linked',
    target: 'node',
  },
  root: import.meta.dirname,
  source: {
    tsconfigPath: './tsconfig.build.json',
    define: {
      __AGENT_BUNDLE_VERSION__: JSON.stringify(packageManifest.version),
    },
    entry: {
      api: './src/api.ts',
      cli: './src/cli.ts',
      'cli-entry': './src/cli-entry.ts',
      config: './src/config/index.ts',
      eval: './src/eval/index.ts',
      'event-ipc': './src/events/ipc.ts',
      'event-project': './src/events/project.ts',
      index: './src/index.ts',
      'install-entry': './src/install-entry.ts',
      'lifecycle-render-child': './src/dev/playground/lifecycle-render-child.ts',
      'mcp-apps': './src/mcp-apps.ts',
      'mcp-entry': './src/mcp-entry.ts',
      meta: './src/meta.ts',
      'mcp-server-runtime': './src/mcp-server-runtime.ts',
      rstest: './src/rstest/index.ts',
      test: './src/test/index.ts',
      'test/browser': './src/test/browser.ts',
    },
  },
});
