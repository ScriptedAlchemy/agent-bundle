export default {
  hooks: {
    sessionStart: { handler: './src/hooks/session-start.ts' },
  },
  marketplace: true,
  mcp: {
    servers: {
      probe: {},
    },
  },
  plugin: {
    description: 'Proves real host installation of Skills, Hooks, and MCP metadata.',
    logo: './docs/media/logo.svg',
    name: 'host-install-proof',
    version: '1.0.0',
  },
  routes: {
    mcpCommands: true,
  },
  skills: ['src/skills/probe'],
  // `plugin` is the unified bundle whose Cursor manifest names `hooks/hooks-cursor.json` (#438).
  targets: ['claude', 'codex', 'cursor'],
};
