# T4 — devRuntime and Dev Log trace fan-in

## Files changed

- `packages/agent-bundle/src/dev/runtime-controller.ts`
- `packages/agent-bundle/src/dev/runtime-protocol.ts`
- `packages/agent-bundle/src/dev/runtime-routes.ts`
- `packages/agent-bundle/src/dev/logs/dev-log-kinds.ts`
- `packages/agent-bundle/src/dev/logs/dev-log-producers.ts`
- `packages/agent-bundle/src/dev/logs/dev-log-service.ts`
- `packages/agent-bundle/tests/runtime-provider.test.ts`
- `packages/agent-bundle/tests/runtime-routes.test.ts`
- `packages/agent-bundle/tests/dev-log-producers.test.ts`
- `packages/agent-bundle/tests/dev-log-service.test.ts`
- `packages/workbench/src/logs/logs-page.tsx`
- `packages/workbench/tests/logs-page.test.ts`

## Exported API and behavior

- `DevRuntimeControllerOptions` and `DevLogServiceOptions` accept
  `readonly trace?: TracePublisher`.
- `DevRuntimeInvocationRequest` accepts the optional browser-minted field
  `correlationId`.
- `DevRuntimeSurface` accepts optional `routeId`, the compiled route represented
  by that provider surface. Runtime trace links require this value.
- Runtime run, generation, and App update events lower into the shared trace.
  Run events carry all available run/correlation/session/epoch fields and link
  to the route invocation. Generation compiling/activated/failed events use
  `runtime.generation.published` with running/ok/error status.
- Dev Logs retain the raw, redacted stream. Warning/error records and records
  carrying trace correlation publish `log.<producer>.<kind>` entries. Ordinary
  uncorrelated info records do not.
- `route.invocation` project logs now carry `invocationId`, `correlationId`,
  and `routeId`.

## Raw logs decision

Keep **Advanced → Raw logs** as the complete redacted producer firehose and
retain its generic producer/level/kind/context filters. It remains useful for
uncorrelated framework chatter and record details that the intentionally slim
trace does not copy. Do not add a competing per-invocation timeline to this
page; Trace owns that workflow.

A row carrying one of the browser join keys links to Trace as:

`/trace?correlation=<correlationId|invocationId|mcpSessionId>`

The precedence is `correlationId`, then `invocationId`, then `mcpSessionId`.
Rows without one of those keys remain raw-log-only.

## Cross-lane requests

- **T1 / integrator:** pass the same `TracePublisher` as `trace` to both
  `new DevRuntimeController(...)` and `new DevLogService(...)` in
  `workbench-server.ts`.
- **T6:** in `packages/workbench/src/application/runtime-backend.ts`, pass the
  browser-minted id on `DevRuntimeInvocationRequest.correlationId` when calling
  `runtimeClient.createRun`.
- **T5:** parse the Raw logs link using exactly the `correlation` query key:
  `/trace?correlation=<value>`.
- **Integrator:** provider surfaces must populate `DevRuntimeSurface.routeId`
  for runtime entries to receive `routeId` and `href`. The example
  `examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts` currently
  emits only provider-local ids (`hook.<host>` / `mcp.<name>`); wire its known
  application route ids when integrating this lane.
- **Docs lane:** state the Raw logs decision above: Trace owns correlated
  per-invocation timelines; Raw logs remains the complete redacted firehose and
  links correlated rows into Trace.

## Open risks

- Existing third-party runtime providers that omit the new optional
  `DevRuntimeSurface.routeId` still publish runtime trace entries, but those
  entries cannot carry a route deep link.
- `runtime.app.updated` currently has an MCP session identity but no run id in
  the existing producer event. It therefore cannot link to a run unless that
  producer later supplies `runId`.

## Changeset and diagnostics

Proposed patch changeset:

> Publish correlated devRuntime and Dev Log activity to the Workbench trace
> (#PR)

No diagnostic codes added.
