import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: {
    description: 'A practical engineering operations bundle for incidents, dependency upgrades, and releases.',
    name: 'skills-starter',
  },
  targets: ['portable', 'codex', 'cursor'],
});
