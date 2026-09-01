import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  marketplace: true,
  mcp: {
    servers: {
      // No `entry` needed: the conventional stdio entry `src/mcp/curator.ts`
      // supplies it, and its default-exported factory runs under the
      // framework lifecycle shell.
      curator: {},
    },
  },
  plugin: {
    description:
      'Complete plan-first audiobook inventory, matching, conversion, repair, and integrity audit.',
    name: 'audiobook-curator',
    // Package identity is derived from package.json. plugin.name stays the
    // host slug; plugin.version must match until a later stage makes it optional.
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
