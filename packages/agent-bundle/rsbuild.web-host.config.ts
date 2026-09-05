import { resolve } from 'node:path';

import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  mode: 'production',
  output: {
    distPath: {
      js: './',
      jsAsync: './',
      root: 'web-host-dist',
    },
    filename: {
      js: 'page.js',
    },
    filenameHash: false,
    target: 'web',
  },
  performance: {
    chunkSplit: {
      strategy: 'all-in-one',
    },
  },
  root: import.meta.dirname,
  source: {
    entry: {
      page: resolve(import.meta.dirname, 'src/web-host/browser/main.ts'),
    },
    tsconfigPath: './tsconfig.web-host.json',
  },
  tools: {
    htmlPlugin: false,
  },
});
