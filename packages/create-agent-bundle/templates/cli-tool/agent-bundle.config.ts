import { defineConfig } from 'agent-bundle';

export default defineConfig({
  // No `version` field: package.json is the single release-version source.
  plugin: {
    description: 'A command-line tool scaffolded from the cli-tool template.',
    name: 'my-agent-plugin',
  },
  // Optional: move the build artifact root (default `dist`); the CLI
  // `--output` flag still wins.
  // output: { distPath: 'artifact' },
  // No `bin` or `scripts` fields needed: the routed `src/cli/**` commands
  // compile into the package executable (dist/bin/my-agent-plugin.js), the
  // conventional `src/scripts/hello.ts` ships as `scripts/hello.mjs` inside
  // every host artifact, and `src/index.ts` becomes the library export with
  // declarations — all by convention.
  targets: ['portable', 'codex', 'claude'],
});
