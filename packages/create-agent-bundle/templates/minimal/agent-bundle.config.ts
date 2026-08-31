import { defineConfig } from 'agent-bundle';

export default defineConfig({
  plugin: {
    description: 'A skills-only agent plugin scaffolded from the minimal template.',
    name: 'my-agent-plugin',
    version: '0.1.0',
  },
  skills: ['skills/getting-started'],
  targets: ['portable', 'codex', 'claude'],
});
