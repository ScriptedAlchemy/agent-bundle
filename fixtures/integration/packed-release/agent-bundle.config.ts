export default {
  hooks: {
    sessionStart: { handler: './src/hook.ts' },
  },
  mcp: {
    servers: {
      fixture: {
        apps: {
          dashboard: {
            entry: './views/dashboard.ts',
            resourceUri: 'ui://packed-release/dashboard.html',
            targets: ['portable'],
            template: './views/shell.html',
          },
        },
        entry: './src/mcp-server.ts',
      },
    },
  },
  plugin: {
    description: 'Exercises an installed Agent Bundle release without workspace sources.',
    name: 'packed-release-fixture',
    version: '1.0.0',
  },
  scripts: {
    review: './src/review.ts',
  },
  skills: ['skills/review'],
  targets: ['portable', 'claude'],
};
