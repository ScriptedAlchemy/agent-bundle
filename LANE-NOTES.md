# S2 — trace correlation through hooks and the dev proxy

Lane: `lane/wb600-pr3-s2`. No identity override: the host's `session_id` stays
`identity.sessionId`. The Workbench `hs_` id travels as receipt `devSession`
and as `x-agent-bundle-dev-session`.

## Files

- `packages/agent-bundle/src/contracts/host-sessions.ts` — **created** with only
  `isHostSessionId`. Merge with S1's file (S1 owns the `HostSession` types).
- `packages/agent-bundle/src/dev/trace/trace-entry.ts` — `'session'` appended
  to `traceSources`. Dedupe if S1 added the same tuple member.
- `packages/agent-bundle/src/events/trace-receipt.ts` — `EVENT_TRACE_RECEIPT_SESSION_ENV`,
  optional `EventTraceReceipt.devSession` posted when the env var is nonempty.
  `identity.sessionId` is still the host payload.
- `packages/agent-bundle/src/dev/hooks/hook-receipts.ts` — accepts `devSession`,
  `isHostSessionId` / `HookReceiptSessionError` (`AB8266`).
- `packages/agent-bundle/src/dev/hooks/hook-receipt-endpoint.ts` —
  `attachHostSession?: (devSession, hostSessionId) => void` on
  `HookReceiptRoutesOptions` / `AttachHookReceiptsOptions`; called after a
  valid decode, before lowering.
- `packages/agent-bundle/src/dev/host-mcp-proxy.ts` —
  `hostMcpProxyRequestInit`, `HOST_MCP_DEV_SESSION_HEADER`. Header sent only
  when the env var is a valid host-session id.
- `packages/agent-bundle/src/dev/host-mcp-routes.ts` — `hostDevSessionId`,
  `HOST_MCP_DEV_SESSION_CODE`, `HostMcpRoutesOptions.traceSessionId?`
  (default identity). Initialize request header → `open({ sessionId: () => … })`.
- `packages/agent-bundle/src/dev/mcp-session/mcp-session-types.ts` —
  `OpenMcpSessionOptions.sessionId?: () => string`.
- `packages/agent-bundle/src/dev/mcp-session/mcp-session-service.ts` /
  `mcp-session-trace-publisher.ts` — `resolveSessionId` called per frame into
  `correlation.sessionId`; frame `_meta.sessionId` still wins.
- Tests: `hook-receipts.test.ts`, `host-mcp-routes.test.ts` (new),
  `mcp-session-trace-publisher.test.ts`. Workbench `trace-model.ts` gained
  exhaustive `'session'` cases so `pnpm typecheck` passes (glyph `▣`,
  headline priority with `hook`).
- Docs: `website/docs/{en,zh}/reference/runtime-environment.mdx`,
  `dev-server-http.mdx` source union, `docs/diagnostics.md` `AB8266`.
- Wrapper templates / hash assertions: **unchanged**.

Did not touch `workbench-server.ts` (S1 wires the callbacks).

## Exported API

- `isHostSessionId(value: unknown): value is string` — `/^hs_[0-9a-z]{16}$/`
- `EVENT_TRACE_RECEIPT_SESSION_ENV = 'AGENT_BUNDLE_DEV_SESSION'`
- `EventTraceReceipt.devSession?: string`
- `HOOK_RECEIPT_SESSION_CODE = 'AB8266'`, `HookReceiptSessionError`
- `attachHostSession?: (devSession: string, hostSessionId: string | undefined) => void`
- `hostMcpProxyRequestInit(env?)`, `HOST_MCP_DEV_SESSION_HEADER`
- `hostDevSessionId(headers)`, `HOST_MCP_DEV_SESSION_CODE`
- `HostMcpRoutesOptions.traceSessionId?: (devSession: string) => string`
- `OpenMcpSessionOptions.sessionId?: () => string`
- `McpSessionTracePublisherOptions.resolveSessionId?: () => string`

## Integrator

1. Merge `contracts/host-sessions.ts` with S1 (keep one `isHostSessionId`).
2. S1: `attachHookReceipts({ attachHostSession: (id, host) => hostSessions.attach(id, host), … })`
   and `new HostMcpRoutes({ …, traceSessionId: (id) => hostSessions.traceSessionId(id) })`.
3. S3: replace the Workbench `'session'` glyph/priority if the Sessions pane
   wants different copy; the group-header `hs_` link is still S3.
4. Dedupe `'session'` on `traceSources` if S1 added it too.
