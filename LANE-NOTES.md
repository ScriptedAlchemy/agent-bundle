# W2 — browser wiring

## Files

- `packages/workbench/src/main.tsx`
- `packages/workbench/src/shell/shell-link.tsx` (new; imported by `trace-page.tsx`, `result-tabs.tsx`, `mcp-page.tsx`)
- `packages/workbench/src/shell/shell.css`
- `packages/workbench/src/advanced/advanced-page.tsx`
- `packages/workbench/src/application/app-route-workspace.tsx`
- `packages/workbench/src/application/executable-route-workspace.tsx`
- `packages/workbench/src/application/invocation-client.ts`
- `packages/workbench/src/application/invocation-model.ts`
- `packages/workbench/src/application/result-tabs.tsx`
- `packages/workbench/src/application/runtime-backend.ts`
- `packages/workbench/src/application/workspace.css`
- `packages/workbench/src/mcp/agent-bundle-remote-transport.ts`
- `packages/workbench/src/mcp/mcp-page.tsx`, `mcp-page.css`
- `packages/workbench/src/mcp/mcp-route-client.ts`
- `packages/workbench/src/mcp/mcp-session-controller.ts`
- `packages/workbench/src/mcp/mcp-session-model.ts`
- `packages/workbench/src/trace/trace-client.ts`
- `packages/workbench/src/trace/trace-page.tsx`, `trace-page.css`
- `docs/diagnostics.md` (the `AB8243` row only)
- Tests: `agent-bundle-remote-transport`, `invocation-client`, `mcp-page`, `mcp-session-controller`, `mcp-session-model`, `route-workspace`, `trace-client`, `shell-link` (new).

## Behavior

1. **Trace client reaches the route workspace.** `main.tsx` passes `clients.traceClient` as `trace: TraceClient` (required) into `ApplicationExplorer`, which forwards it to `RouteWorkspace`; the Trace result tab now leaves "Loading correlated trace…" once the replay lands. `RouteWorkspaceProps.trace` stays optional so `route-workspace.test.ts` renders without a client.

2. **App-workspace correlation seam.** The browser never sends `_meta` to the session route any more:
   - `McpRouteOperation` `tools/call` gains `correlationId?: string`; `mcp-route-client.ts` exports `mcpCorrelationMetaKey = 'agent-bundle/correlationId'` (the same literal the server's `mcp-session-trace-publisher.ts` exports; the browser cannot import from `dev/**`).
   - `McpSessionControllerRequest.correlationId?` — `invoke` stamps it into the SDK request's `params._meta[mcpCorrelationMetaKey]` (for `callTool` and `callToolTask`), which is the only channel from the SDK `Client` to the transport.
   - `AgentBundleRemoteTransport.operationFor` lifts that key out of `params._meta` into the top-level `correlationId` of the operation body and forwards nothing else from `_meta` (the SDK's `progressToken` was already dropped before this change). Wire body is unit-tested: `{"arguments":…,"correlationId":"corr-app","name":…,"operation":"tools/call","requestId":"number:20"}` with no `_meta`.
   - `appToolCallRequest(name, input, correlationId)` now returns `{ correlationId, request: { arguments, name } }` and the App workspace spreads it into `controller.invoke`.
   - Runtime-bound sessions: `runtimeRouteOperationFor` puts `correlationId` on the `McpRouteOperation`, but the runtime bridge (`appBindingOperationFor` → `McpAppBindingOperation`, `runtimeOperationRequest` → `DevRuntimeMcpOperationRequest`) has no slot for it — see cross-lane request below.
   - Dev-server runs: `RouteInvocationRequest.correlationId` was already threaded by the route controller (`newCorrelationId()` → `client.invoke(request)`; `invocation-client.ts` serializes the whole request). Runtime runs: `runtime-backend.ts` already forwarded `correlationId`; `DevRuntimeInvocationRequest` already declares it, so the redundant `& Readonly<{ correlationId?: string }>` intersections were removed.

3. **Protocol page shows the lifted MCP correlation.** `mcp-session-controller.ts` `traceEntry` decodes optional `id`, `method` (non-empty strings ≤ 256 chars) and `meta` (a record with only `correlationId`/`conversationId`/`requestId`/`sessionId`, each a bounded string); anything else fails the stream with the existing "invalid entry" error (`mcp.trace.stream.error`). `mcp-session-model.ts` exports `McpBrowserSessionFrameEntry`, `isMcpFrameEntry`, and `mcpFrameMetaKeys`; the reducer's `snapshot` already retained the fields. The Raw protocol tab (`McpProtocolEvidence`, also used by the runtime-contract compile test) renders a facts line per frame — direction, `method`, `id`, and each lifted meta key — with `correlationId` as a `ShellLink` to `/trace?correlation=<id>`. `McpPage` and `McpProtocolEvidence` accept `onNavigate?`; `AdvancedPage` passes its router into `ProtocolSection`.

4. **`requestId` on invocations.** `invocation-client.ts` summary/invocation decoders accept `requestId: textSchema.optional()` (a non-string is `AB8230`); `invocationSummaryOf` echoes it; the status line shows `request <id>` beside `correlation <id>` (`.route-status-request`). The invoke body carries whatever `correlationId`/`requestId` the request has (tested).

5. **`AB8249` → `AB8243`.** `TRACE_INVALID_RESPONSE_CODE = 'AB8243'` (trace-client.ts + doc comment), pinned in `trace-client.test.ts`. `docs/diagnostics.md` row now reads: browser decoder `AB8243`, sitting between the trace routes (`AB8240`–`AB8242`) and the hook receipt route (`AB8247`–`AB8249`); `AB8244`–`AB8246` unassigned. The `AB8247`–`AB8249` server row is untouched.

6. **Dead PR 1 trace CSS.** `shell.css` keeps only `.problem-list`, `.problem-link`, `.problem-link:hover`; `.trace-table`, `.trace-status--succeeded/--failed`, and all `.trace-entry*` rules are gone. `.trace-link` and the `.trace-status` base rule are *not* dead — `trace-page.tsx` uses both (`StatusPill`, detail-drawer links) — so they moved into `trace-page.css` next to the `--ok/--error/--running` modifiers. `git grep` confirms no markup uses the deleted classes (only `data-testid="trace-entry"` remains, which is an attribute, not the class).

7. **Route workspace ↔ Trace round trip.** The private `Link` in `trace-page.tsx` became the shared `ShellLink` (`shell/shell-link.tsx`: real `href`, `preventDefault` + `onNavigate` on click, plain anchor when no router). `result-tabs.tsx` uses it for "Open in Trace" (`{ area: 'trace', correlation }` → `/trace?correlation=<id>`, verified in `route-workspace.test.ts`) and for each `TraceRow` (`{ area: 'trace', invocationId: entry.id }` → `/trace/<id>`), and `ExecutableRouteWorkspace` now passes `onNavigate` into `ResultTabs`, so the round trip no longer reloads the app. `/trace/<inv_…>` still resolves through `selectTraceEntry`'s invocation-id fallback (`trace-model.test.ts` covers `inv_3`).

## Cross-lane requests

- **Server (T3/T4 owner, `packages/agent-bundle/src/dev/runtime-protocol.ts` + `contracts/mcp-apps.ts`):** the runtime App path cannot carry the Workbench correlation. Exact edit: add `readonly correlationId?: string;` to the `call-tool` member of `DevRuntimeMcpOperationRequest` (runtime-protocol.ts ~line 240) and to the `tools/call` member of `McpAppBindingOperation`, then stamp it into `params._meta[mcpCorrelationMetaKey]` where the runtime MCP session service builds the `tools/call` request. Browser side is ready: `runtimeRouteOperationFor` already sets `correlationId` on the `McpRouteOperation`; once the contracts gain the field, `appBindingOperationFor` (mcp-session-controller.ts) and `runtimeOperationRequest` (mcp-route-client.ts) need one line each to forward it.
- **Server (`contracts/mcp-session.ts`):** consider re-exporting `mcpCorrelationMetaKey` from the contract so the browser copy in `mcp-route-client.ts` can import it instead of restating the literal. Not blocking.
- **W3 (e2e):** `tests/audiobook-curator.acceptance.e2e.test.ts:112` locates `.trace-table tr[data-invocation-id=…]`, a PR 1 selector that no longer exists in the Trace page markup (rows are `.trace-row`/`.trace-line` and carry no `data-invocation-id`). Use `getByTestId('trace-entry')` or `.trace-line[href="/trace/<id>"]`.
- **W3 (e2e):** new hooks for acceptance: `data-testid="mcp-frame-facts"` on Protocol-page frames, `.route-status-request` on the invocation status line, `.mcp-page-frame-link` for the correlation link.

## Open risks

- `isMcpFrameEntry` narrows an `unknown` timeline value by `kind`/`direction`/`sequence` only; it relies on the controller's strict decoder being the sole producer of frames (it is — the model reducer never fabricates frames).
- `McpProtocolEvidence` still takes `readonly unknown[]` for the runtime-contract test; the frame facts render only for values that pass `isMcpFrameEntry`, so provider-evidence callers are unaffected.
- The redundant `& Readonly<{ correlationId?: string }>` removal in `runtime-backend.ts` is type-only; `DevRuntimeInvocationRequest.correlationId` already exists in `runtime-protocol.ts`.

## Verification

- `pnpm build && npx tsc --project packages/workbench/tsconfig.json --noEmit && npx tsc --noEmit && pnpm lint` — green.
- `npx rstest --config rstest.unit.config.ts` over `advanced-page`, `agent-bundle-remote-transport`, `dev-server-backend`, `invocation-client`, `invocation-model`, `logs-page`, `mcp-page`, `mcp-session-controller`, `mcp-session-model`, `route-workspace`, `runtime-backend`, `runtime-contract-compile`, `shell-link`, `trace-client`, `trace-model`, `trace-page`, `workbench-router`, `workbench-shell` — 18 files, 215 tests, 0 failures.
- Deslop pass over the diff: shared `mcpFrameMetaKeys` instead of two key lists and two `as` casts; `ShellLink` extracted and rewired in the same change (no private `Link` left behind); `runtime-backend.ts` intersection types dropped.
