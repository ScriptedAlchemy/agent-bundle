import { defineConfig } from 'agent-bundle';

export default defineConfig({
  plugin: {
    description: 'A release-readiness Skill with deterministic evidence evaluation.',
    name: 'skills-starter',
    version: '1.0.0',
  },
  skills: ['skills/release-review'],
  targets: ['portable', 'codex', 'claude'],
});
