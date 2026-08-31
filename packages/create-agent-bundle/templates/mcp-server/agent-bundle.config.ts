import { defineConfig } from 'agent-bundle';

export default defineConfig({
  mcp: {
    servers: {
      // No `entry` needed: the conventional stdio entry `src/mcp/status.ts`
      // supplies it, and its default-exported factory runs under the
      // framework lifecycle shell.
      status: {},
    },
  },
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
