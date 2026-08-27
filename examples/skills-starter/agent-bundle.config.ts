import { defineConfig } from 'agent-bundle';

export default defineConfig({
  plugin: {
    description: 'A practical engineering operations bundle for incidents, dependency upgrades, and releases.',
    name: 'skills-starter',
    version: '1.0.0',
  },
  skills: [
    'skills/dependency-upgrade',
    'skills/incident-triage',
    'skills/release-review',
  ],
  targets: ['portable', 'codex', 'claude'],
});
