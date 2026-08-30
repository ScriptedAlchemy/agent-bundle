// FRAMEWORK GAP: this second bundler config exists only because `agent-bundle
// build` emits host artifacts (artifact/{claude,codex}) but no node-consumable
// dist/ for the package's own `bin` and `exports`. The CLI is therefore built
// twice — once here into dist/cli.js for bin/audiobook-curator.js, and once by
// `agent-bundle build` into artifact/*/scripts/audiobook-curator.mjs — from
// two configs driving the same bundler family. Once agent-bundle owns the
// package build ("one config, agent-bundle owns the build"), this file and
// tsconfig.build.json should be deleted. See the maintainer notes in README.md.
import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      bundle: true,
      dts: true,
      format: 'esm',
      syntax: 'es2022',
    },
  ],
  output: {
    cleanDistPath: true,
    filenameHash: false,
    target: 'node',
  },
  root: import.meta.dirname,
  source: {
    entry: {
      cli: './src/cli.ts',
      index: './src/index.ts',
    },
    tsconfigPath: './tsconfig.build.json',
  },
});
