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
  // One CLI bundle, two destinations: `src/cli.ts` is the package bin by
  // convention, and declaring it as a script also ships it inside every
  // host artifact. `src/index.ts` becomes the library export with
  // declarations, also by convention.
  scripts: {
    'my-agent-plugin': './src/cli.ts',
  },
  targets: ['portable', 'codex', 'claude'],
});
