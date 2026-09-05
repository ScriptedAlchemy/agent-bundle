// Plain object export keeps this packed fixture independent of the package build (#564).
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
  // Omitting `tool` proves unique live-server resolution.
  web: { apps: [{ allow: ['call-tool'], app: 'status/status' }] },
};
