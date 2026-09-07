import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  assets: ['evals/fixtures/status/result.json'],
  hooks: {
    sessionStart: { handler: './src/hooks/session-start.ts' },
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
