# T6 lane notes

## Files changed

- `packages/workbench/src/application/app-route-workspace.tsx`
- `packages/workbench/src/application/event-route-workspace.tsx`
- `packages/workbench/src/application/executable-route-workspace.tsx`
- `packages/workbench/src/application/result-tabs.tsx`
- `packages/workbench/src/application/route-workspace.tsx`
- `packages/workbench/src/application/runtime-backend.ts`
- `packages/workbench/src/application/workspace-contracts.ts`
- `packages/workbench/src/application/workspace.css`
- `packages/workbench/tests/route-workspace.test.ts`
- `packages/workbench/tests/runtime-backend.test.ts`

## Exported API

- `TraceTimeline`
- `appToolCallRequest`
- `newCorrelationId`
- `RouteWorkspaceProps.trace?: TraceClient`

## Cross-lane requests

- T5: replace the `packages/workbench/src/trace/trace-client.ts` stub with the real client, construct it in `main.tsx`, and pass the exact prop `trace: TraceClient` through `ApplicationExplorer` to `RouteWorkspace`.
- T3: preserve `_meta['agent-bundle/correlationId']` from App workspace `callTool` requests through the MCP session client and session service.
- T2: if `RouteInvocationRequest.requestId` lands, no application controller change is needed because the draft spread preserves it; ensure invocation decoding and persistence echo it.

## Open risks

- The lane keeps `RouteWorkspaceProps.trace` optional so it compiles before T5's `main.tsx` wiring lands. Without that integration prop, the Trace result tab remains in its loading state.
- The App correlation token is stamped on the MCP request but is not currently displayed in the App workspace.

## Changeset and diagnostics

- No changeset: `packages/workbench` is private.
- No new diagnostics.
- Proposed changeset line: none.
