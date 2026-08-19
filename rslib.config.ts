import { defineConfig } from '@rslib/core';
import packageManifest from './packages/agent-bundle/package.json' with { type: 'json' };

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
      { from: './packages/workbench/dist', to: 'workbench', info: { minimized: true } },
      { from: './packages/workbench/THIRD_PARTY_NOTICES', to: 'workbench/THIRD_PARTY_NOTICES', toType: 'file' },
      { from: './packages/workbench/src/inspector/UPSTREAM.json', to: 'workbench/src/inspector/UPSTREAM.json', toType: 'file' },
      { from: './packages/workbench/src/inspector/LICENSE.inspector', to: 'workbench/src/inspector/LICENSE.inspector', toType: 'file' },
      { from: './packages/workbench/src/inspector/PATCHES.md', to: 'workbench/src/inspector/PATCHES.md', toType: 'file' },
    ],
    filenameHash: false,
    legalComments: 'linked',
    minify: {
      jsOptions: {
        exclude: /^workbench[\\/]/u,
      },
    },
    distPath: {
      root: './packages/agent-bundle/dist',
    },
    externals: [
      '@modelcontextprotocol/client',
      '@modelcontextprotocol/client/stdio',
      '@modelcontextprotocol/node',
      '@modelcontextprotocol/server',
      '@rsbuild/core',
      '@rsbuild/plugin-react',
      '@rslib/core',
      '@rslint/core',
      '@rstackjs/load-config',
      '@rspack/core',
      'ajv',
      'ajv/dist/2020.js',
      'chokidar',
      'commander',
      'fast-glob',
      'ignore',
      'jiti',
      'yaml',
    ],
    target: 'node',
  },
  source: {
    tsconfigPath: './tsconfig.build.json',
    define: {
      __AGENT_BUNDLE_VERSION__: JSON.stringify(packageManifest.version),
    },
    entry: {
      api: './packages/agent-bundle/src/api.ts',
      cli: './packages/agent-bundle/src/cli.ts',
      config: './packages/agent-bundle/src/config/index.ts',
      eval: './packages/agent-bundle/src/eval/index.ts',
      index: './packages/agent-bundle/src/index.ts',
      'mcp-apps': './packages/agent-bundle/src/mcp-apps.ts',
    },
  },
});
