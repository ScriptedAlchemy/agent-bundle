import { resolve } from 'node:path';

import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const sourceRoot = resolve(import.meta.dirname, 'src');
const vendorRoot = resolve(sourceRoot, 'inspector', 'vendor');

/**
 * The contributor dev process proxies to a separately started foreground
 * server. Production assets never proxy: they are served by that foreground
 * server directly from the published package.
 */
export const createWorkbenchConfig = (apiProxyTarget = process.env.AGENT_BUNDLE_WORKBENCH_API_PROXY) => ({
  html: {
    template: resolve(import.meta.dirname, 'index.html'),
  },
  output: {
    assetPrefix: '/',
    copy: [
      { from: resolve(import.meta.dirname, 'THIRD_PARTY_NOTICES'), to: 'THIRD_PARTY_NOTICES', toType: 'file' },
      { from: resolve(sourceRoot, 'inspector', 'UPSTREAM.json'), to: 'src/inspector/UPSTREAM.json', toType: 'file' },
      { from: resolve(sourceRoot, 'inspector', 'LICENSE.inspector'), to: 'src/inspector/LICENSE.inspector', toType: 'file' },
      { from: resolve(sourceRoot, 'inspector', 'PATCHES.md'), to: 'src/inspector/PATCHES.md', toType: 'file' },
    ],
    distPath: {
      root: 'dist',
    },
    filenameHash: false,
    filename: {
      assets: '[name][ext]',
      css: '[name].css',
      js: '[name].js',
    },
  },
  plugins: [pluginReact()],
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@inspector/core/json/xMcpHeader.js': resolve(vendorRoot, 'core', 'json', 'xMcpHeader.ts'),
      '@inspector/core/mcp/fetchTracking.js': resolve(vendorRoot, 'core', 'mcp', 'fetchTracking.ts'),
      '@inspector/core/mcp/types.js': resolve(vendorRoot, 'core', 'mcp', 'types.ts'),
      '@inspector/core': resolve(vendorRoot, 'core'),
    },
  },
  source: {
    entry: {
      'inspector-closure': resolve(sourceRoot, 'inspector-closure.tsx'),
      index: resolve(sourceRoot, 'main.tsx'),
    },
  },
  ...(apiProxyTarget === undefined ? {} : {
    server: {
      proxy: {
        '/api': { target: apiProxyTarget },
      },
    },
  }),
});

// Without an explicit mode, rsbuild falls back to mode 'none' whenever the
// ambient NODE_ENV is any nonstandard value (such as 'test' from a test
// runner), which disables the NODE_ENV define and minification and ships a
// bundle that crashes in the browser with "process is not defined". Pinning
// the mode to the CLI command keeps builds hermetic regardless of caller env.
export default defineConfig(({ command }) => ({
  mode: command === 'dev' ? ('development' as const) : ('production' as const),
  ...createWorkbenchConfig(),
}));
