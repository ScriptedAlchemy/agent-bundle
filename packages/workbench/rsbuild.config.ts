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
  output: {
    assetPrefix: '/',
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
        '/api': { changeOrigin: true, target: apiProxyTarget },
      },
    },
  }),
  tools: {
    rspack: {
      resolve: {
        extensionAlias: {
          '.js': ['.js', '.ts', '.tsx'],
          '.jsx': ['.jsx', '.tsx'],
        },
      },
    },
  },
});

export default defineConfig(createWorkbenchConfig());
