import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  marketplace: true,
  mcp: {
    servers: {
      // Declared without an entry so the conventional src/mcp/host-test-raw.ts
      // factory is served under the framework stdio lifecycle shell.
      'host-test-raw': { transport: 'stdio' },
    },
  },
  plugin: {
    description:
      'Probe what each agent host sends to plugin hooks and MCP servers: raw payloads, request context, lineage.',
    // The host-native plugin slug; the npm package name is scoped and never
    // becomes a slug.
    name: 'host-test',
  },
  runtime: { node: '22.19.0' },
  // Every canonical event family lives under src/events/** and restricts its
  // own targets to the hosts whose pinned capability table supports it, so
  // one probe covers claude, codex, and cursor without a per-host config.
  // The generated `host-test` MCP server (src/mcp/host-test/tools) hosts the
  // shared event runtime; `src/mcp/host-test-raw.ts` is a hand-rolled stdio
  // server that records the raw MCP request envelope for correlation.
  // The rendered `src/cli/dump.tsx` command compiles into dist/bin/host-test.mjs.
  targets: ['claude', 'codex', 'cursor', 'portable'],
});
