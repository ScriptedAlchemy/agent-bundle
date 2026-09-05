# T1 lane notes

## Files

- Hardened `packages/agent-bundle/src/dev/trace/trace-hub.ts`.
- Added `packages/agent-bundle/src/dev/trace/trace-routes.ts`.
- Added `packages/agent-bundle/src/dev/trace/trace-project-events.ts`.
- Wired the trace through `packages/agent-bundle/src/dev/foreground-server.ts` and `packages/agent-bundle/src/dev/workbench-server.ts`.
- Registered diagnostics in `docs/diagnostics.md`.
- Added `trace-hub.test.ts`, `trace-routes.test.ts`, and `trace-dev-server.test.ts`; registered the integration test in `rstest.integration-tests.ts`.

## Exported API

- `TraceHub` retains the existing `publish`, `replay`, `subscribe`, `close`, and `latestSequence` API. Construction now requires `projectRoot`; options also expose encoded history, entry, and subscriber byte/count bounds.
- `TraceRoutes` mounts authenticated `GET /api/trace` replay and `GET /api/trace/stream` NDJSON streaming.
- `attachProjectEventTrace(trace, projectEvents)` returns a detach callback and lowers failed build, contract, and host-sync events. It intentionally ignores `route.invocation`, because T2 publishes invocation trace entries directly.

## Cross-lane requests

- Drop the final `STUBS (drop on integration)` commit once T2/T3/T4 provide `readonly trace?: TracePublisher` on `RouteInvocationServiceOptions`, `McpSessionServiceOptions`, `DevRuntimeControllerOptions`, and `DevLogServiceOptions`.
- Preserve the `trace` option name on all four services; `workbench-server.ts` already supplies it.
- No edits are requested for frozen `dev/trace/trace-entry.ts` or `contracts/trace.ts`.

## Open risks

- The four stub option fields accept the hub but do not publish. T2/T3/T4 own those producer implementations.
- Project-event lowering emits one contract diagnostic entry per failed route so each entry carries `routeId`; a failed contract event without route failures still emits one epoch-correlated entry.

## Changeset

Proposed patch summary: Expose authenticated live trace replay and streaming with AB8240–AB8242 diagnostics (#PR).

## Diagnostics

- `AB8240`: invalid trace cursor (400).
- `AB8241`: trace cursor ahead of the current sequence (409).
- `AB8242`: trace routes unavailable (404/503).
