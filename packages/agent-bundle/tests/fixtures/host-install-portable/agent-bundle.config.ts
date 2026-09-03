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
  portable: {
    author: { name: 'Agent Bundle proof harness', url: 'https://github.com/ScriptedAlchemy/agent-bundle' },
    extensions: { 'com.example.proof': { fixture: true } },
    homepage: 'https://github.com/ScriptedAlchemy/agent-bundle',
    keywords: ['proof', 'agent-plugins'],
    license: 'MIT',
    repository: 'https://github.com/ScriptedAlchemy/agent-bundle',
  },
  skills: ['src/skills/probe'],
  targets: ['portable'],
};
