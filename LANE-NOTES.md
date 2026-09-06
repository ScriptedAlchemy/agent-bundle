# Lane B3 notes

## Merge resolution

Merged `origin/main` at `7e56517756` through merge commit `552244904b`.

| File | Hunk | Resolution |
| --- | --- | --- |
| `packages/workbench/tests/support/workbench-acceptance.ts` | `workbenchTestIds` | Kept `staticAuthoredDocument` plus `traceDetail`, `traceEntry`, and `traceGroup`; ordered all route/static/trace keys alphabetically. |
| `packages/agent-bundle/src/adapters/hook-contract.ts` | Standalone renderer | Combined `preflight` with the trace and receipt arguments. The rendered event payload includes preflight data while render start/finish/failure and receipt lineage remain intact. |
| `packages/agent-bundle/src/adapters/hook-contract.ts` | Shared/standalone dispatch | Kept receipt open/identity/send and execute tracing; threaded `preflight` through shared IPC, direct standalone execution, and transport fallback. Non-deferred wrappers declare it `undefined`. |
| `packages/agent-bundle/src/adapters/hook-contract.ts` | Preflight wrapper | Kept the receipt observer and identity/send lifecycle. Both string and object execute outcomes proceed, and object outcomes pass `gate.data` to the deferred executor. |

`route-invocation-production.ts` retained main's preflight payload projection and the trace branch's live observer. The event runtime and test render consumers compiled in the full gate. The #664 hash pins already matched the merged generated sources, so no hash was regenerated.

## Deslop

13 edits.

| Category | File | Edit |
| --- | --- | --- |
| Changeset | `.changeset/wb600-application-explorer.md`, `.changeset/wb600-live-trace.md` | Restored main's existing #629 changeset and added exactly one `agent-bundle` patch changeset for live trace, all endpoints, cancelled status, and diagnostics. |
| Shared helper | `packages/agent-bundle/src/dev/routes/route-invocation-routes.ts` | Deleted the local `noQuery` and invalid-shape thrower; reused `dev/http.ts` `noQuery` and `badRequest`. |
| Restating comments | `packages/agent-bundle/src/dev/hooks/hook-receipt-endpoint.ts` | Replaced lane/wiring narration with the security invariant and removed comments that repeated method names. |
| Restating comments | `packages/agent-bundle/src/dev/hooks/hook-receipts.ts` | Removed lane history, UI narration, and comments repeating constants. |
| Restating comments | `packages/agent-bundle/src/events/trace-receipt.ts` | Reduced the module comment to the wire privacy boundary and removed field/constant narration. |
| Restating comments | `packages/agent-bundle/src/dev/trace/trace-entry.ts` | Removed the PR-history module comment. |
| Restating comments | `packages/workbench/src/trace/trace-client.ts` | Removed PR/lane/test-owner narration. |
| Restating comments | `packages/workbench/src/trace/trace-model.ts` | Removed structural field narration and replaced PR-history wording with the compatibility invariant. |
| Restating comments | `packages/workbench/src/trace/trace-page.tsx` | Removed page and prop comments that repeated the implementation. |
| Reference accuracy | `website/docs/en/reference/dev-server-http.mdx` | Added the streaming and cancellation endpoints, `stream: true`, `202`, and cancelled-envelope behavior. |
| Reference accuracy | `website/docs/zh/reference/dev-server-http.mdx` | Added the matching Chinese endpoint and cancellation reference. |
| Placeholder prose | `website/docs/en/guide/development/workbench.mdx` | Removed speculation about a later embedded host-session UI. |
| Placeholder prose | `website/docs/zh/guide/development/workbench.mdx` | Removed the matching speculative translation. |

The trace and invocation routes already share `createBackpressuredWriter` and `writeKeepAliveStreamHead` from `dev/route-streams.ts`; trace uses NDJSON and invocation uses SSE, so their frame decoders are intentionally transport-specific. `trace-client.ts` decodes unified `TraceEntry` values while `invocation-client.ts` decodes `EventTraceEvent` and `RouteInvocation` values; no duplicate wire schema remained to extract.

Every added production module has a production importer. No dead export or module was found.

## Suspected bugs fixed

- `packages/agent-bundle/tests/route-invocation-dev-server.test.ts`: the new live and invalid-input preludes allowed a newer startup epoch to publish after the test captured or modified the prior epoch. Capturing the artifact immediately before the assertion that uses it, and writing the operator `.env` immediately before the valid invocations, removes the stale-fixture race without changing production behavior.

## Speculative items flagged

- The unified trace still publishes runtime, correlated log, and project diagnostic sources beyond the six live-trace acceptance fixtures. They have production callers, tests, public source vocabulary, and bilingual documentation, so deleting them here would change behavior rather than deslop it.
- No unmeasured telemetry was found. Durations in the diff come from recorded start/finish timestamps or child-reported measured durations.

## Gates

| Command | Result |
| --- | --- |
| `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit` | Initial pass: 4,352 passed, 6 skipped. Final rerun: build/typecheck/lint passed; 4,351 passed, 6 skipped, 1 load-sensitive failure because the oversized-output fixture hit its timeout first. |
| `pnpm exec rstest --config rstest.unit.config.ts packages/agent-bundle/tests/native-codex-contract.test.ts` | Rerun passed: 11 passed, 1 skipped; the timeout/output-limit test passed. |
| `pnpm test:route-unit` | Passed: 10 files, 89 passed. |
| `AGENT_BUNDLE_WORKBENCH_PREBUILT=1 AGENT_BUNDLE_PACKAGE_PREBUILT=1 pnpm exec rstest --config rstest.integration.config.ts packages/agent-bundle/tests/hook-receipt-pipe.test.ts packages/agent-bundle/tests/mcp-session-service.test.ts packages/agent-bundle/tests/route-invocation-dev-server.test.ts packages/agent-bundle/tests/target-hook-contract.test.ts packages/agent-bundle/tests/trace-dev-server.test.ts packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts packages/workbench/tests/lifecycles.e2e.test.ts` | First run exposed the stale-fixture race (47 passed, 2 failed). After the test fix, passed: 7 files, 49 passed. |
| `pnpm test:packed packages/workbench/tests/packed-release.e2e.test.ts` | Passed: 1 file, 1 passed. |
| `pnpm docs:site:build` | Passed: locale drift 0; diagnostics coverage complete; language parity passed; 0 broken links across 28,295 anchors. |
| `git diff --check` | Passed. |
