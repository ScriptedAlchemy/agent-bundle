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
        // One artifact-path argument (the packaged payload file) beside a
        // literal, and env carrying a plugin-data token: the launch record
        // must carry all three for <plugin> web to start the server with them.
        args: ['--config', 'agent-bundle:path:plugin-root/config/status.json'],
        env: { STATUS_CACHE: 'agent-bundle:path:plugin-data/cache', STATUS_MODE: 'packed' },
      },
    },
  },
  payload: { config: './payload/config' },
  plugin: {
    description: 'A plugin whose MCP App is exposed through web.apps and opened with <plugin> web.',
    name: 'web-surface-fixture',
    version: '1.0.0',
  },
  targets: ['portable'],
  // Omitting `tool` proves unique live-server resolution.
  web: { apps: [{ allow: ['call-tool'], app: 'status/status' }] },
};
