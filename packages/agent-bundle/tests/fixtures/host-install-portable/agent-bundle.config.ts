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
  // The §5.4 descriptive metadata is declared once in package.json and shared
  // with every host; only the §5.6 client extension is portable-specific.
  portable: {
    extensions: { 'com.example.proof': { fixture: true } },
  },
  skills: ['src/skills/probe'],
  targets: ['portable'],
};
