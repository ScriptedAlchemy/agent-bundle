import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  assets: ['evals/fixtures/status/result.json'],
  hooks: {
    sessionStart: { handler: './src/hooks/session-start.ts' },
  },
  mcp: {
    servers: {
      status: {
        apps: {
          status: {
            entry: './views/status-panel.ts',
            resourceUri: 'ui://mcp-app-example/status.html',
            targets: ['portable'],
            template: './views/status-panel.html',
          },
        },
      },
    },
  },
  plugin: {
    description: 'A unified service-readiness assistant with MCP, Skills, Hooks, scripts, and evaluation.',
    name: 'mcp-app-example',
    version: '1.0.0',
  },
  scripts: {
    'check-service-fixture': './src/scripts/check-service-fixture.ts',
  },
  targets: ['portable', 'codex', 'claude'],
  web: { apps: [{ app: 'status/status', tool: 'show-status', allow: ['call-tool'] }] },
});
