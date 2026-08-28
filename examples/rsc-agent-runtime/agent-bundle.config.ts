import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  claude: {},
  codex: {},
  dev: { runtime: { provider: './src/dev/provider.ts' } },
  hooks: {
    afterTool: {
      handler: './src/hook/cli.ts',
      targets: ['claude', 'codex'],
      tools: ['file.write'],
    },
  },
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
        entry: './src/mcp/stdio.ts',
        targets: ['portable', 'claude', 'codex'],
        transport: 'stdio',
      },
    },
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
