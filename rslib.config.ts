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
    distPath: {
      root: './packages/agent-bundle/dist',
    },
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
    },
  },
});
