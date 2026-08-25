import { defineConfig } from 'agent-bundle';

export default defineConfig({
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
        entry: './src/mcp-server.ts',
      },
    },
  },
  plugin: {
    description: 'An interactive MCP App plus deterministic evaluation.',
    name: 'mcp-app-example',
    version: '1.0.0',
  },
  targets: ['portable'],
});
