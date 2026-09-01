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
  // verify-release ships by convention: unclaimed plain scripts under
  // src/scripts/ are discovered. detect-risk stays explicitly configured
  // because it restricts targets.
  scripts: {
    'detect-risk': {
      entry: './src/scripts/detect-risk.ts',
      targets: ['portable'],
    },
  },
  targets: ['portable', 'codex', 'claude'],
});
