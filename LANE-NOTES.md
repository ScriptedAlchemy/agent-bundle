# A9 lane notes

## Changed

- Replaced the epoch-scoped helper with `devStateRoot(projectRoot)`.
- Workbench route invocations and dev MCP session launches now share the same
  framework-owned state root.
- Extended stateful route parity across a successful republish; unit-render
  remains isolated.
- Updated the MCP session environment assertion and en/zh Workbench and MCP
  documentation.

## Path contract

- Before: `<project>/.agent-bundle/epochs/<epoch>/state`
- After: `<project>/.agent-bundle/state`

`AGENT_BUNDLE_PLUGIN_ROOT` remains the selected epoch. Isolated unit-render
continues to create and remove its own temporary state root.

## Tests

- Focused integration: `route-invocation-dev-server.test.ts` and
  `mcp-session-service.test.ts`
- Full gate: `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit`,
  relevant integration pool, and `pnpm docs:site:build`

## Ambiguities

- `/tmp/wb600/notes-pr2a/A2.md` and `A5.md` were not present when this lane
  began, so their requested production-path rationale could not be read.
