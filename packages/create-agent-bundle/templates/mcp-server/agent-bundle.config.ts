import { defineConfig } from 'agent-bundle';

export default defineConfig({
  lib: './src/status.ts',
  plugin: {
    description: 'A stdio MCP server plugin scaffolded from the mcp-server template.',
    name: 'my-agent-plugin',
    version: '0.1.0',
  },
  scripts: {
    'check-status': './src/scripts/check-status.ts',
  },
  targets: ['portable', 'codex', 'claude'],
});
