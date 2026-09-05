# Lane A2 — P1-B production execution boundary

## Files

- Added `packages/agent-bundle/src/dev/routes/route-invocation-production.ts`.
- Updated the route-invocation child/service/result contracts, HTTP request parser, prepared
  project state root, and test manifest event identity.
- Shared generated CLI input preparation in `src/cli-entry.ts` and generated bins.
- Exposed compiled event preparation from generated hook wrappers.
- Added opt-in provider/handler/render observations to generated Flight workers.
- Updated route-invocation, generated-entry, Workbench decoder, and acceptance tests.
- Updated `docs/diagnostics.md` and the English/Chinese Workbench guides.

## Behavior

- An absent invocation `mode` now means `production`. The child imports the published epoch's
  compiled modules and workers. `mode: "unit-render"` retains the live-source Jiti route-unit
  renderer and its disposable state.
- CLI invocations import the compiled bin's `prepareRouteInvocation`, which delegates argv,
  confirmation, defaults, `mapInput`, and schema validation to the same exported
  `cli-entry.ts` helpers used by the generated bin.
- Event invocations import the compiled hook wrapper's `prepareRouteInvocation`. All wrappers
  provide native-envelope validation and canonical props; preflight wrappers additionally run
  the real gate and create the real `EventTracer`. `continue` and `deny` return before a render
  worker is started.
- Production rendering dispatches to the epoch's generated Flight worker. The worker mounts the
  generated request scope, selected providers, and generated runtime state. The child sets
  `AGENT_BUNDLE_PLUGIN_ROOT` from `request.stateRoot`, so workspace-durable sqlite state persists
  across invocations while volatile state keeps the generated in-memory behavior.
- Observation is opt-in on the worker message and records actual provider outcomes/durations,
  aggregate provider duration, handler duration, and render duration. Event traces receive
  provider/render phase boundaries in worker execution order.
- Full invocation responses may carry event trace events. Invocation summaries deliberately
  omit them; the Workbench strict decoder accepts and validates the full trace field.

## Generated-entry path parity

- Hook wrapper: the child imports the generated hook wrapper's shared
  `prepareRouteInvocation`, then dispatches to the generated MCP/hooks Flight worker. It skips
  stdin byte framing, executor process spawning, signal forwarding, and stdout writing; native
  response projection remains the shared `events/projection.ts` path in the invocation service.
- CLI bin: the child imports the generated bin's `prepareRouteInvocation` and dispatches to its
  generated sibling Flight worker. It skips command-tree selection, terminal probing, output
  formatting, and process exit-code handling after the selected route and argv are known.
- MCP server: the child dispatches through `createAgentRenderDispatcher` to the generated MCP
  Flight worker and projects tools with `documentToCallToolResult`. It skips JSON-RPC transport,
  MCP initialization, and SDK request framing; provider selection, request scope, state, route
  module, layouts, and Flight rendering are the same compiled worker bytes.
- Rendered script: the child dispatches to the generated script `-flight.mjs` worker. It skips
  the generated CLI process envelope and stdout formatting; route scope, state, layouts, and
  rendering are the same worker bytes.
- There is no interim Jiti production path. Jiti remains only in explicit `unit-render` mode.

## Exported API / contract changes

- `RouteInvocationRequest.mode?: "production" | "unit-render"` is accepted on the HTTP wire.
- `RouteInvocationPreparedProject.stateRoot: string` and the child request's artifact, event
  target, state root, and mode fields were added.
- `RouteInvocationChildResult.observed` carries measured providers and timings.
- `RouteInvocationChildResult.trace` and full `RouteInvocation.trace` carry event-kernel events.
- `parseGeneratedCliArgv`, `mapGeneratedCliInput`, and their supporting public types are exported
  from `agent-bundle/cli-entry` for generated bins and the production boundary.
- Generated hook and CLI artifact modules export `prepareRouteInvocation`.

## Cross-lane requests

- A1: after merging `dev/routes/route-module-loader.ts`, rewire only the `unit-render` branch in
  `route-invocation-child.ts` to that loader; keep production on
  `route-invocation-production.ts`.
- A3: reconcile the temporary `RouteInvocationPreparedProject.stateRoot` field and
  `join(prepared.root, ".agent-bundle", "state")` fill in
  `src/dev/workbench-server.ts` with the epoch-lease implementation. Preserve the artifact root,
  generated artifact epoch token, and state root passed to the child.
- A4: consume `child.observed` in the result assembly and remove fabricated zero-duration
  provider/handler telemetry as planned. Preserve `trace` propagation, the
  `invocationSummary()` trace omission, and the trace schema in
  `packages/workbench/src/application/invocation-client.ts` while merging provider-status
  decoder changes.

## Open risks

- Worker ownership is discovered from the published artifact's generated `*-flight.mjs` files;
  `AB8251` is returned when no compiled worker owns the selected route.
- Production intentionally bypasses host transports after route selection. Transport-level MCP
  handshake behavior, CLI formatting, and hook stdin/process behavior remain covered by their
  existing generated-entry tests rather than being repeated by the Workbench invocation.
- The TraceDecay MCP and CLI daemon were unavailable during final review. The full diff was
  manually deslop-reviewed; repository lint, type checks, tests, and dead-module checks passed.

## Verification

- PASS: `pnpm build && npx tsc --noEmit && npx tsc --project packages/workbench/tsconfig.json --noEmit && pnpm lint`
- PASS: focused unit pool (76 tests), including entry-shell, CLI projection,
  route-invocation service, and Workbench invocation decoder coverage.
- PASS: `rstest.integration.config.ts packages/agent-bundle/tests/route-invocation-dev-server.test.ts`
  (2 tests).
- PASS: generated CLI and hook integration files (52 tests).
- PASS: `rstest.integration.config.ts packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts`
  (1 browser acceptance test at the repository's 1440×900 viewport).
- PASS: `pnpm docs:site:build`.
- PASS: `git diff --check`.
- PASS: dead-module check; `route-invocation-production` has the production importer
  `route-invocation-child.ts`.

## Proposed changeset

Patch `agent-bundle`: Execute Workbench route invocations through published generated artifacts
by default, including CLI projection, event preflight, persistent state, and measured runtime
telemetry. (#PR)

## Diagnostic codes

- `AB8250`: no published compiler artifact is available.
- `AB8251`: the selected route has no executable in the published artifact.
- `AB8252`: compiled CLI projection or event preparation failed.
