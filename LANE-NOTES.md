# W1 — server wiring

## Files

- `packages/agent-bundle/src/dev/workbench-server.ts`
- `packages/agent-bundle/src/dev/foreground-server.ts`
- `packages/agent-bundle/src/dev/hooks/hook-receipts.ts`
- `packages/agent-bundle/src/dev/playground/lifecycle-replay-service.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation-child.ts`
- `packages/agent-bundle/tests/hook-receipt-pipe.test.ts`
- `packages/agent-bundle/tests/hook-receipts.test.ts`
- `packages/agent-bundle/tests/route-invocation-dev-server.test.ts`
- `packages/agent-bundle/tests/trace-dev-server.test.ts`
- `examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts`
- `examples/rsc-agent-runtime/tests/dev-provider.integration.test.ts`

## Behavior

- The foreground dev server now mounts the self-authorizing hook receipt route before browser-session-authorized routes.
- Dev startup publishes `.agent-bundle/hook-receipts.json`, passes its environment to Workbench hook simulations, and removes the record before closing the foreground server.
- Hook receipts replay as unified `hook.received` and terminal hook entries. Their display labels use `tool · before` rather than the canonical `tool/before`, because browser-wire path sanitization intentionally redacts slash-bearing prose; exact canonical identity remains in correlation and `href`.
- Lifecycle replay now uses the shared `nativeEventRequestContext` implementation.
- Event route invocations emit kernel phase trace entries from the invocation child, correlated with the invocation trace.
- Runtime-provider hook, tool, resource, and App surfaces now carry their application route IDs.
- The trace dev-server integration test verifies bearer authorization, browser refusal (`AB8247`), trace replay, endpoint-record cleanup, and a generated hook wrapper discovering the endpoint through an installed `.agent-bundle-dev.json` marker.

## Cross-lane requests

- T7 request fulfilled: hook receipt attachment, endpoint publication, simulation environment, foreground dispatch, close ordering, and integration coverage are wired.
- T2 requests fulfilled: lifecycle request-context extraction is rewired and route invocation trace replay covers invocation and kernel entries.
- T4 request fulfilled: runtime provider surfaces carry application route IDs.
- No outgoing cross-lane requests.

## Open risks

- None known. The RSC demo models one logical MCP server across its target descriptors; tool and resource route IDs use that server name, while App route IDs use each App descriptor's `serverName`.

## Verification

- `pnpm build && npx tsc --noEmit && pnpm lint`
- Required agent-bundle unit tests: 109 passed.
- Required agent-bundle integration tests: 36 passed.
- Lifecycle route-unit tests: 5 passed.
- RSC runtime example tests: 172 passed, 6 skipped; route-unit tests: 3 passed.
- Focused RSC provider integration rerun after deslop: 41 passed; example typecheck passed.

## Proposed changeset line

Expose host hook receipts and correlated route execution in the unified development trace. (#600)
