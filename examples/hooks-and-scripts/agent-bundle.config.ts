import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  assets: ['release/*.json'],
  hooks: {
    sessionStart: { handler: './src/hooks/session-start.ts' },
  },
  plugin: {
    description: 'Hook simulation, script traces, logs, and recovery.',
    name: 'hooks-and-scripts',
    version: '1.0.0',
  },
  scripts: {
    'detect-risk': {
      entry: './src/scripts/detect-risk.ts',
      targets: ['portable'],
    },
    'verify-release': './src/scripts/verify-release.ts',
  },
  targets: ['portable', 'codex', 'claude'],
});
