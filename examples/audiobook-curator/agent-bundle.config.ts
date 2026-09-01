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
    // Release identity is derived from package.json: `packageName` and
    // `packageVersion` flow into the project context, artifact manifests,
    // inspect output, and dev status. This declared version must match the
    // package.json version — a mismatch reports the AB4008 warning. The
    // package.json version is the single version source; this field only
    // restates it until plugin.version becomes optional (issue #94 stage 3).
    version: '1.0.0',
  },
  runtime: { node: '22.19.0' },
  // `src/cli.ts` is the package bin by convention; declaring it as a script
  // also ships it inside every host artifact.
  scripts: {
    'audiobook-curator': './src/cli.ts',
  },
  // No `skills` field needed: `skills/curate-audiobooks/SKILL.md` is
  // discovered by convention.
  targets: ['claude', 'codex'],
});
