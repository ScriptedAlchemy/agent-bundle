import { defineConfig } from 'agent-bundle';

export default defineConfig({
  plugin: {
    description: 'A minimal public example for authoring portable skills.',
    name: 'skills-starter',
    version: '1.0.0',
  },
  skills: ['skills/release-review'],
  targets: ['portable', 'codex', 'claude'],
});
