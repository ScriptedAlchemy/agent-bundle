import { defineConfig } from 'agent-bundle';

export default defineConfig({
  lib: './src/status.ts',
  // No `version` field: package.json is the single release-version source.
  plugin: {
    description: 'A stdio MCP server plugin scaffolded from the mcp-server template.',
    name: 'my-agent-plugin',
  },
  scripts: {
    'check-status': './src/scripts/check-status.ts',
  },
  targets: ['portable', 'codex', 'claude'],
});
