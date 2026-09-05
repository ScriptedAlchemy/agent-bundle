# T2 — route invocation + execution-kernel publishing

## Files changed

- `packages/agent-bundle/src/dev/routes/route-invocation-child.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation-service.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation.ts`
- `packages/agent-bundle/src/events/trace.ts`
- `packages/agent-bundle/tests/event-trace.test.ts`
- `packages/agent-bundle/tests/route-invocation-dev-server.test.ts`
- `packages/agent-bundle/tests/route-invocation-service.test.ts`

`route-invocation-routes.ts` remains unchanged, preserving the existing
`route.invocation` project event exactly as shipped by PR 1.

## Exported API

- `RouteInvocationServiceOptions.trace?: TracePublisher`
- `RouteInvocationRequest.requestId?: string`
- `RouteInvocationSummary.requestId?: string`
- `nativeEventRequestContext(...)` from `dev/routes/route-invocation.ts`
  (shared server-side lowering seam; not re-exported from `contracts/invocations.ts`)

The render-child IPC now has a `trace` message carrying one `EventTraceEvent`.

## Cross-lane integration requests

1. T1: pass the dev server's `TraceHub` as `trace` when constructing
   `RouteInvocationService` in `workbench-server.ts`.
2. Integrator/lifecycle owner: in
   `dev/playground/lifecycle-replay-service.ts`, import
   `nativeEventRequestContext` from `../routes/route-invocation.ts`; replace
   the `replayRequestContext(event, native, routeId, target,
   hostContractRevision)` call with
   `nativeEventRequestContext({ event, native, routeId, target,
   hostContractRevision })`; then delete the local `nativeText`,
   `replayLineage`, and `replayRequestContext` helpers. This completes the
   extract-and-rewire and removes the temporary duplicate lowering.
3. Workbench invocation-client owner: allow optional `requestId` in the strict
   request/summary decoders and thread it from browser invocation requests.
4. After T1's `/api/trace` route lands, extend
   `route-invocation-dev-server.test.ts` to assert the HTTP replay. This lane
   tests publishing through a fake `TracePublisher`; the route and a
   `startDevServer` trace injection option are absent on this branch.

## Open risks

- `EventTraceProvidersFinish` exposes only aggregate provider duration and
  count, not per-provider durations. The invocation's aggregate `providers`
  timing uses the real duration, while named `providers[]` and
  `provider:<name>` timings remain `0` until the kernel exposes named
  durations.
- The child observer covers Workbench route invocations. Standalone installed
  host-wrapper processes still need their own runtime-to-foreground transport.

## Verification

- `pnpm build`
- `npx tsc --noEmit`
- `pnpm lint`
- Unit: 25 passed
- Integration: 2 passed
- Deslop: GPT-5.6 Sol, 2 edits (strict child trace decoding; removed one
  unused import).

## Changeset

Proposed patch summary:

> Publish correlated route invocation and execution-kernel entries to the
> Workbench trace, including native event provenance and request IDs. (#PR)

## Diagnostics

No new diagnostic codes.
