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
  },
  routes: {
    mcpCommands: true,
  },
  skills: ['src/skills/probe'],
  // One composite root; the Cursor manifest names `.cursor-plugin/hooks.json` beside Claude's `hooks/hooks.json` (#438).
  targets: ['claude', 'codex', 'cursor'],
};
