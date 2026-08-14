import { resolve } from 'node:path';

import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const sourceRoot = resolve(import.meta.dirname, 'src');
const vendorRoot = resolve(sourceRoot, 'inspector', 'vendor');

export default defineConfig({
  output: {
    assetPrefix: '/',
    distPath: {
      root: 'dist',
    },
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
      'inspector-closure': resolve(sourceRoot, 'main.tsx'),
    },
  },
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
