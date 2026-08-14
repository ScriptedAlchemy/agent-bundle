export default {
  claude: { nativeHooks: './native/claude-hooks.json' },
  codex: { nativeHooks: './native/codex-hooks.json' },
  hooks: {
    sessionStart: { handler: './src/hook.ts' },
  },
  marketplace: true,
  mcp: {
    servers: {
      local: {
        apps: {
          dashboard: {
            _meta: { ui: { prefersBorder: true } },
            entry: './views/dashboard.ts',
            resourceUri: 'ui://integration-fixture/dashboard-v1.html',
            targets: ['portable'],
            template: './views/shell.html',
          },
        },
        entry: './src/mcp-server.ts',
      },
      'remote-http': {
        headers: { 'X-Fixture': 'integration' },
        transport: 'streamable-http',
        url: 'https://mcp.example.test/stream',
      },
    },
  },
  plugin: {
    description: 'A complete Agent Bundle compiler integration fixture.',
    name: 'integration-fixture',
    version: '1.0.0',
  },
  scripts: {
    bundle: './src/bundle.ts',
    python: './src/python.py',
    shell: './src/shell.sh',
  },
  targets: ['portable', 'codex', 'claude'],
};
