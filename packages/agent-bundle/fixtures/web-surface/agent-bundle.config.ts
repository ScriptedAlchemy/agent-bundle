// The `<plugin> web` packed proof (#564): one MCP server with one App exposed
// through `web.apps`, beside one authored routed CLI command
// (`src/cli/dashboard.ts`) — so the generated `bin/<plugin>.mjs` carries the
// framework-owned `web` command and the author's command in one executable.
// Plain object export, like every other repository fixture: the fixture must
// compile without the package's own built configuration entry.
export default {
  mcp: {
    servers: {
      status: {
        apps: {
          status: {
            entry: './views/status.ts',
            resourceUri: 'ui://web-surface-fixture/status.html',
            targets: ['portable'],
            template: './views/status.html',
          },
        },
      },
    },
  },
  plugin: {
    description: 'A plugin whose MCP App is exposed through web.apps and opened with <plugin> web.',
    name: 'web-surface-fixture',
    version: '1.0.0',
  },
  targets: ['portable'],
  // No `tool`: the one tool declaring the App's `_meta.ui.resourceUri`
  // (`status`) is resolved on the live server. `call-tool` is pre-approved so
  // App-initiated tool calls never wait on the consent panel.
  web: { apps: [{ allow: ['call-tool'], app: 'status/status' }] },
};
