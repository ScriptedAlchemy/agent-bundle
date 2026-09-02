import { defineConfig } from 'agent-bundle';

export default defineConfig({
  // No `skills` field needed: every `src/skills/<name>/SKILL.md` directory is
  // discovered by convention. Declare `skills:` only to override the layout.
  plugin: {
    description: 'A skills-only agent plugin scaffolded from the minimal template.',
    name: 'my-agent-plugin',
    version: '0.1.0',
  },
  // Optional: move the build artifact root (default `dist`); the CLI
  // `--output` flag still wins.
  // output: { distPath: 'artifact' },
  targets: ['portable', 'codex', 'claude'],
});
