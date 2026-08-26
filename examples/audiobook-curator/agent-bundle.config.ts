import { defineConfig } from 'agent-bundle';

export default defineConfig({
  marketplace: true,
  mcp: {
    servers: {
      curator: {
        entry: './src/mcp-server.ts',
        targets: ['codex', 'claude'],
      },
    },
  },
  plugin: {
    description: 'Plan-first audiobook inventory, preparation, and integrity audit.',
    name: 'audiobook-curator',
    version: '1.0.0',
  },
  skills: ['skills/curate-audiobooks'],
  targets: ['codex', 'claude'],
});
