import { defineConfig } from 'agent-bundle';

export default defineConfig({
  hooks: {
    sessionStart: { handler: './src/hooks/session-start.ts' },
  },
  plugin: {
    description: 'Hook simulation, script traces, logs, and recovery.',
    name: 'hooks-and-scripts',
    version: '1.0.0',
  },
  scripts: {
    fail: './src/scripts/fail.ts',
    succeed: './src/scripts/succeed.ts',
  },
  targets: ['portable', 'codex', 'claude'],
});
