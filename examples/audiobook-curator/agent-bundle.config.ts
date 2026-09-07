import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  marketplace: true,
  plugin: {
    description:
      'Complete plan-first audiobook inventory, matching, conversion, repair, and integrity audit.',
    // `name` is the host-native plugin slug — deliberately not the npm
    // package name (`@agent-bundle-example/audiobook-curator`); scoped npm
    // names never become slugs.
    name: 'audiobook-curator',
    // No `version` field: package.json is the single version source. It flows
    // into the project context, artifact manifests, inspect output, dev
    // status, and the `agent-bundle/meta` constant this plugin imports.
  },
  runtime: { node: '22.19.0' },
  // No `routes`, `scripts`, or `bin` fields needed: every curator tool's
  // colocated `<tool>.cli.ts` projection compiles into the shared
  // artifact/package executable (bin/audiobook-curator.mjs) by convention,
  // so one operation is one command (#725).
  // No `skills` field needed: `src/skills/curate-audiobooks/SKILL.md` is
  // discovered by convention.
  targets: ['claude', 'codex'],
});
