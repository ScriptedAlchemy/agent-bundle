# Lane T3 — MCP protocol fan-in (#600 PR 2)

Branch `lane/wb600-pr2-t3`, based on `wb600-pr2-trace`.

## Files

Added

- `packages/agent-bundle/src/dev/mcp-session/mcp-session-trace-publisher.ts` — `createMcpSessionTraceSink`,
  `liftMcpFrame`, `mcpCorrelationMetaKey`. Imported by `mcp-session.ts` (frame lifting) and
  `mcp-session-service.ts` (per-session sink); re-exported from `mcp-session-service.ts`.
- `packages/agent-bundle/tests/mcp-session-trace-publisher.test.ts` — unit pool.

Changed

- `mcp-session-protocol.ts` — `McpSessionFrameTraceEntry` gains optional `id` (JSON-RPC id as string), `method`,
  `meta: McpSessionTraceMeta` (`correlationId` / `conversationId` / `requestId` / `sessionId`, lifted from
  `params._meta`). New exported `McpSessionTraceMeta`; also re-exported from `contracts/mcp-session.ts`. Additive.
- `mcp-session-trace.ts` — `composeMcpSessionTraceSinks(...sinks)`: per-sink try/catch fan-out.
- `mcp-session-types.ts` — `McpSessionServiceOptions.trace?: TracePublisher`.
- `mcp-session-service.ts` — builds one `createMcpSessionTraceSink({ binding, projectRoot, sessionId, trace })` per
  session and composes it with the existing `traceSink` (dev logs). `createMcpDevLogTraceSink` is untouched.
- `mcp-session.ts` — `#recordFrame` spreads `liftMcpFrame(snapshot)` onto the frame trace entry.
- `mcp-session-routes.ts` — `tools/call` accepts optional `correlationId` (nonempty, ≤ 256 chars, same bound as
  `RouteInvocationRequest.correlationId`); the route stamps it into `params._meta['agent-bundle/correlationId']`.
  `McpSessionRouteSession.callTool` / `callToolTask` option type is now the exported `McpSessionRouteToolCall`
  (adds `_meta?: McpRequestMeta`). A browser-supplied `_meta` is still rejected (AB8016).
- `tests/mcp-session-routes.test.ts`, `tests/mcp-session-service.test.ts` — new cases (see Tests).

## Lowering (kind → TraceEntry)

All entries: `source: 'mcp'`, correlation `{ epochId, host: binding.target, mcpSessionId }`, `occurredAt` from the
session entry's unix-ms clock.

| Session entry | Trace kind | Correlation / details |
|---|---|---|
| client frame with `id` + `method` | `mcp.request` (`status: running`) | `mcpRequestId`, `routeId` (`tool:<server>/<name>` for `tools/call`, `prompt:<server>/<name>` for `prompts/get`), `_meta` keys → `requestId` (`claudecode/toolUseId`), `conversationId` / `sessionId` (`x-codex-turn-metadata.thread_id` / `.session_id`), `correlationId` (`agent-bundle/correlationId`). `details: { method, name?, paramsBytes }` — params size only. |
| frame with `id`, no `method` | `mcp.response` (`ok` / `error`) | inherits the request's correlation by JSON-RPC id; `durationMs` = response − request `occurredAt`; `details: { resultBytes, isError? }` or `{ error: { code, message } }` with the message through `safeDevWireText`. A JSON-RPC error or `result.isError === true` is `error`. |
| frame with `method`, no `id` (except progress/message) | `mcp.notification` | `notifications/cancelled` joins the pending request by `params.requestId`. `details: { direction, method }`. |
| `progress` entry | `mcp.progress` (`running`) | joins the request whose id or `_meta.progressToken` equals `progressToken`; `details: { progress?, total?, progressToken? }`. |
| `logging` entry | `mcp.logging` | `details: { level?, logger? }` — never `data`. |
| `stderr` entry | `mcp.stderr` | summary = first line, ≤ 200 chars, through `safeDevWireText`; `details: { bytes }`. |
| `operation initialize succeeded` (first) / `restart succeeded` | `mcp.session.started` | once per connect; restart summary says "restarted". |
| `operation close succeeded|failed` | `mcp.session.closed` (`ok` / `error`) | once. |
| other `operation` entries | — | not lowered: the request/response frames already carry the protocol operation, and the `kind` vocabulary has no `mcp.operation`. The dev-log sink still records them. |

Frames for `notifications/progress` and `notifications/message` are not lowered as frames; the session's dedicated
`progress` / `logging` entries carry them, so each event is one `TraceEntry`.

`href`: `applicationNodePath(node) + '?session=<mcpSessionId>'` when the route id maps to a node, else
`/advanced/protocol?session=<mcpSessionId>`. Responses, progress, and cancellations use the href of the request they
join.

Every `_meta` key is bounded (≤ 256 chars, no control characters or path separators) before it reaches the wire.
Pending requests are capped at 1 024 per session (oldest evicted) so an unanswered cancel cannot grow the map.

## Cross-lane requests

- **T1 (`workbench-server.ts`)** — pass the hub as `trace` on the existing constructor:

  ```ts
  const mcpSessions = new McpSessionService({
    epochStore, projectRoot: root, registry, platformRuntime,
    trace: traceHub,
    traceSink: createMcpDevLogTraceSink(logs),
  });
  ```

  The option name is `trace`, as the brief specifies. No other server change.

- **T6 (route workspace / MCP controller)** — the browser cannot put `_meta` on a session `tools/call` today (the route
  rejects it), so it could not pass a correlation id. The route now accepts a top-level `correlationId` on the
  `tools/call` operation body and stamps it into `_meta` itself. To join an MCP-backed run to the route workspace's
  `correlationId`, add `correlationId?: string` to the `tools/call` member of `McpRouteOperation`
  (`packages/workbench/src/mcp/mcp-route-client.ts` ~line 91) and thread the workspace's minted id through
  `McpSessionController.invoke` → `AgentBundleRemoteTransport` → the operation body. Nothing else on the server needs to
  change; the `mcp.request` / `mcp.response` entries then carry `correlation.correlationId`.

- **T5 (Protocol page, `packages/workbench/src/mcp/mcp-session-controller.ts` `traceEntry`)** — the decoder does not
  reject the new fields, so it was left alone; it does *drop* them when re-picking known keys (lines ~405–406). To show
  and link `id` / `method` / `meta` on Advanced → Protocol, copy them through when present (all optional strings, `meta`
  an object of optional strings — `McpSessionTraceMeta` is exported from `contracts/mcp-session.ts`).

- **Trace entry contract (frozen)** — no additions needed. One observation: `TraceCorrelation.requestId` is used here
  for the host tool-use id per the brief; the MCP session's own cancel-handle `requestId`
  (`McpSessionToolCallOptions.requestId`) is intentionally *not* lowered to avoid the collision.

## Open risks / notes

- `resources/read` has no `routeId`: the request names a URI, the route id needs the resource's name, and the session
  only holds `{ epochId, serverName, target }`. Those entries link to `/advanced/protocol?session=…`. Mapping URI →
  `resource:<server>/<name>` needs the route manifest (`RouteManifestRoute.config`) — a follow-up if wanted.
- Session `serverName` is used as the route id's `<server>` segment; that matches how the App workspace opens sessions
  (`leaf.ref.server`) and how `protocol-name.ts` derives the wire name (final id segment, no override).
- `notifications/cancelled` leaves the pending request in place (the server may still answer); the map is bounded.
- `safeDevWireText` redacts a whole line that contains `<letter>:` (drive-letter guard), so a stderr line like
  `warn: …` becomes `stderr: [REDACTED]`. That is the shared helper's existing behavior, not new here.
- Host-originated MCP (Claude/Codex talking to the generated server directly) is still invisible — only Workbench-owned
  sessions publish, as scoped.

## Proposed changeset line (patch)

```
Publish every Workbench MCP session frame, notification, stderr line, and lifecycle step onto the unified trace
(`mcp.request` / `mcp.response` paired by JSON-RPC id with `durationMs`, `mcp.notification`, `mcp.progress`,
`mcp.logging`, `mcp.stderr`, `mcp.session.started` / `mcp.session.closed`) through the new
`McpSessionServiceOptions.trace`; lift `id`, `method`, and `_meta` correlation keys onto `McpSessionTraceEntry`; accept
`correlationId` on the session `tools/call` operation and stamp it into `_meta['agent-bundle/correlationId']` (#PR)
```

## Diagnostic codes

None added. `AB8016` already covers the malformed `correlationId` shape.

## Tests

- `packages/agent-bundle/tests/mcp-session-trace-publisher.test.ts` (unit): frame lifting; request/response pairing,
  duration, tool `routeId`, `_meta` → correlation, `href`; JSON-RPC error / tool error status and redaction; orphan
  responses; notification / progress / logging / stderr lowering (one entry each, no raw payloads, stderr redaction);
  session started/closed once; throwing publisher isolated from the `McpSessionTraceLog` and sibling sinks.
- `packages/agent-bundle/tests/mcp-session-service.test.ts` (integration, existing file): real fixture server —
  `mcp.session.started` → `initialize` request/response → `notifications/initialized` → `tools/call inspect`
  (with `claudecode/toolUseId` + `agent-bundle/correlationId` in `_meta`) → `prompts/get` → `resources/read` → stderr
  → `mcp.session.closed`; every response equals its request's correlation with `durationMs ≥ 0`; no project root on the
  wire; the lifted `id` / `method` / `meta` are on the session's own trace; a throwing publisher does not break
  `open` / `callTool` / `close`.
- `packages/agent-bundle/tests/mcp-session-routes.test.ts` (unit): `correlationId` stamps `_meta`; empty, over-long,
  and browser-supplied `_meta` are `AB8016`.

Gate run: `pnpm build && npx tsc --noEmit && npx tsc --project packages/workbench/tsconfig.json --noEmit && pnpm lint`,
unit: `mcp-session-trace-publisher`, `mcp-session-routes`, `mcp-tasks`, `dev-log-producers`,
`workbench/mcp-session-controller`, `workbench/mcp-session-model`; integration: `mcp-session-service.test.ts` (27/27).
