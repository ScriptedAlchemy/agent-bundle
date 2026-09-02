export default {
  hooks: {
    sessionStart: { handler: './src/hooks/session-start.ts' },
  },
  mcp: {
    servers: {
      probe: {},
    },
  },
  plugin: {
    description: 'Proves portable installer and filesystem/schema conformance.',
    name: 'host-install-portable-proof',
    version: '1.0.0',
  },
  skills: ['src/skills/probe'],
  targets: ['portable'],
};
