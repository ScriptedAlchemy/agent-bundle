import { resolve } from 'node:path';

import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const sourceRoot = resolve(import.meta.dirname, 'src');

/**
 * The contributor dev process proxies to a separately started foreground
 * server. Production assets never proxy: they are served by that foreground
 * server directly from the published package. The proxy leaves the browser's
 * `Origin` untouched (Rsbuild's default `changeOrigin` rewrites only `Host`),
 * so the foreground must allowlist this dev origin; `strictPort` fails loudly
 * on a busy port instead of silently moving the UI to one it has not allowed.
 */
export const createWorkbenchConfig = (apiProxyTarget = process.env.AGENT_BUNDLE_WORKBENCH_API_PROXY) => ({
  html: {
    template: resolve(import.meta.dirname, 'index.html'),
  },
  output: {
    assetPrefix: '/',
    copy: [
      { from: resolve(import.meta.dirname, 'THIRD_PARTY_NOTICES'), to: 'THIRD_PARTY_NOTICES', toType: 'file' },
      { from: resolve(sourceRoot, 'mcp', 'APP-RENDERER-LICENSE'), to: 'src/mcp/APP-RENDERER-LICENSE', toType: 'file' },
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
  source: {
    entry: {
      index: resolve(sourceRoot, 'main.tsx'),
    },
  },
  ...(apiProxyTarget === undefined ? {} : {
    server: {
      proxy: {
        '/api': { target: apiProxyTarget },
      },
      strictPort: true,
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
