// The `agent-bundle/serve-app-command` packed proof (#558): one MCP server
// with one App, and a routed CLI command (`src/cli/dashboard.ts`) that serves
// the App by spawning `agent-bundle serve-app` from inside the generated bin.
// Plain object export, like every other repository fixture: the fixture must
// compile without the package's own built configuration entry.
export default {
  mcp: {
    servers: {
      status: {
        apps: {
          status: {
            entry: './views/status.ts',
            resourceUri: 'ui://serve-app-command-fixture/status.html',
            targets: ['portable'],
            template: './views/status.html',
          },
        },
      },
    },
  },
  plugin: {
    description: 'A routed CLI command that serves this plugin\'s MCP App through agent-bundle/serve-app-command.',
    name: 'serve-app-command-fixture',
    version: '1.0.0',
  },
  targets: ['portable'],
};
