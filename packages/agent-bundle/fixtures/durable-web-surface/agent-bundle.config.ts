// Plain object export keeps this packed fixture independent of the package
// build, like web-surface. The generated `journal` server (src/mcp/journal)
// carries the config-declared status App, and src/state.ts makes the project
// workspace-durable: the packed read-only-install proof spawns its entry and
// its CLI bin against an artifact nothing may write beneath (#637).
export default {
  mcp: {
    servers: {
      journal: {
        apps: {
          status: {
            entry: './views/status.ts',
            resourceUri: 'ui://durable-web-surface-fixture/status.html',
            targets: ['portable'],
            template: './views/status.html',
          },
        },
      },
    },
  },
  plugin: {
    description: 'A workspace-durable plugin whose MCP App is exposed through web.apps and whose CLI reads the same state.',
    name: 'durable-web-surface-fixture',
    version: '1.0.0',
  },
  targets: ['portable'],
  web: { apps: [{ allow: ['call-tool'], app: 'journal/status' }] },
};
