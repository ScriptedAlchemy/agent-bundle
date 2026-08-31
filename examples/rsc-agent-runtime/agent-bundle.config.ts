import { defineConfig } from 'agent-bundle/config';

// The RSC runtime and App payloads are compiled by this example's own
// multi-environment Rsbuild build (see rsbuild.config.ts); agent-bundle
// packages those prebuilt trees verbatim and generates the host manifests,
// so this file is the single declaration for both development and packaging.
export default defineConfig({
  claude: {},
  codex: {},
  dev: { runtime: { provider: './src/dev/provider.ts' } },
  hooks: {
    afterTool: [
      {
        args: ['--host', 'claude'],
        handler: { prebuilt: './dist/runtime/hook/index.js' },
        targets: ['claude'],
        timeout: 30,
        tools: ['file.write'],
      },
      {
        args: ['--host', 'codex'],
        handler: { prebuilt: './dist/runtime/hook/index.js' },
        targets: ['codex'],
        timeout: 30,
        tools: ['file.write'],
      },
    ],
  },
  marketplace: true,
  mcp: {
    servers: {
      timeline: {
        apps: {
          timeline: {
            _meta: {
              'openai/widgetDescription': 'Interactive timeline of recorded file edits.',
            },
            entry: './src/widget/index.tsx',
            resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
            targets: ['portable', 'claude', 'codex'],
          },
        },
        entry: { prebuilt: './dist/runtime/mcp/stdio.js' },
        targets: ['portable', 'claude', 'codex'],
        transport: 'stdio',
      },
    },
  },
  payload: {
    app: './dist/app',
    runtime: './dist/runtime',
  },
  portable: {},
  plugin: {
    description: 'React Server Components agent runtime demonstration.',
    name: 'rsc-agent-runtime-demo',
    version: '1.0.0',
  },
  skills: [],
  targets: ['portable', 'claude', 'codex'],
});
