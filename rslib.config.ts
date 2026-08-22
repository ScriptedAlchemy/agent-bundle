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
    distPath: {
      root: './packages/agent-bundle/dist',
    },
    // autoExternal cannot see the published dependencies here because this
    // config builds from the workspace root, whose package.json declares no
    // runtime dependencies. Derive externals from the published manifest so
    // the list cannot drift, matching subpaths (e.g. ajv/dist/2020.js) the
    // way autoExternal does.
    externals: Object.keys(packageManifest.dependencies).map(
      (name) => new RegExp(`^${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}($|/)`),
    ),
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
