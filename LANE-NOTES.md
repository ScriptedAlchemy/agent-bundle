# L1 — dev-server route invocation service

## Files added

- `packages/agent-bundle/src/dev/routes/route-invocation-service.ts`
  - Strict request decoding, route resolution through the injected current
    manifest service, two-child admission semaphore, 60 s timeout, 200-entry
    newest-first history, summary projection, host canonicalization/projection,
    MCP/CLI projection, and child lifecycle.
  - Exports `RouteInvocationService`, `RouteInvocationPreparedProject`,
    `RouteInvocationFixture`, `InvocationRingBuffer`,
    `parseRouteInvocationRequest`, and `invocationSummary`.
- `packages/agent-bundle/src/dev/routes/route-invocation-routes.ts`
  - Protected POST/list/read HTTP boundary and `route.invocation` publication.
- `packages/agent-bundle/src/dev/routes/route-invocation-child.ts`
  - React-server child entry. It installs lazy jiti loaders for routes,
    providers, layouts, and state from the prepared test-runtime manifest,
    then renders through `renderRouteEvents`.
- `packages/agent-bundle/tests/route-invocation-service.test.ts`
  - Strict request, summary, and ring-buffer contracts.
- `packages/agent-bundle/tests/route-invocation-dev-server.test.ts`
  - Real dev-server tool/event child renders, provider mounting, MCP/host
    projections, list/read round trip, SSE, and SPA fallback.

## Files changed

- `packages/agent-bundle/src/dev/foreground-server.ts`
  - Mounts invocation routes before the broad route-manifest matcher.
  - Adds extensionless Workbench-shell GET fallback to `index.html`.
- `packages/agent-bundle/src/dev/types.ts`
  - Adds `route.invocation` to `ProjectEventPayloadMap`.
- `packages/agent-bundle/src/dev/events.ts`
  - Admits `route.invocation` on `ProjectEventHub`.
- `packages/agent-bundle/src/dev/logs/dev-log-kinds.ts`
- `packages/agent-bundle/src/dev/logs/dev-log-producers.ts`
  - Required exhaustive consumers of the expanded project-event union.
- `rstest.integration-tests.ts`
  - Registers the child-spawning integration test.
- `docs/diagnostics.md`
  - Registers `AB8231`, `AB8232`, and replacement free codes
    `AB8236`–`AB8238`; `AB8233`–`AB8235` were already assigned.

The foundation invocation contract and
`packages/agent-bundle/src/contracts/invocations.ts` required no field or
re-export changes.

## Diagnostic codes

- `AB8231`: unknown route id or invocation id.
- `AB8232`: no published build / invocation manifest unavailable.
- `AB8236`: render child timed out or crashed (replacement for occupied
  `AB8233`).
- `AB8237`: malformed invocation request (replacement for occupied `AB8234`).
- `AB8238`: fixture id unknown (replacement for occupied `AB8235`).

## Cross-lane / integrator requests

1. `packages/agent-bundle/src/dev/workbench-server.ts` owns the prepared
   project closure and must create the production service next to
   `routeManifest`, then pass it as `routeInvocations` to
   `startForegroundServer`. Construct `RouteInvocationPreparedProject.manifest`
   with `testManifestFromRouteGraph` from the *existing*
   `latestValidPreparedProject` (`routeGraph`, model/plugin/apps/scripts/state,
   config path, targets, root). This is a projection of the same compiler pass,
   not `compileTestManifest()` and not a second discovery. The integration test
   uses the existing `testing.startForegroundServer` seam because this file is
   outside L1 ownership.
2. The current `RouteManifestRoute` contract has no fixture list despite the
   PR brief referring to manifest fixtures. Whichever lane adds those fixture
   descriptors should pass their strict JSON seeds as
   `RouteInvocationPreparedProject.fixtures[routeId]`; the service already
   enforces unknown ids with `AB8238`.
3. The current `renderRouteEvents` result exposes the document, events,
   structured result, and provenance, but not provider mount receipts or
   separate provider/handler/render durations. L1 records the measured
   end-to-end child render duration, projection duration, mounted provider
   inventory, and explicit zero-duration provider/handler subphases. If exact
   phase telemetry is required for PR 1 acceptance, extend the shared render
   harness/result in its owning lane and populate the child response from
   those receipts.
4. The new child intentionally does not replace
   `playground/lifecycle-render-child.ts` in this lane because the lifecycle
   service/protocol files are outside L1 ownership. Both use the same
   `renderRouteEvents` production kernel; a follow-up consolidation can make
   lifecycle replay call the generalized child protocol.

## Verification

Passed:

```text
pnpm build
npx tsc --noEmit
pnpm lint
npx rstest --config rstest.unit.config.ts packages/agent-bundle/tests/route-invocation-service.test.ts
npx rstest --config rstest.integration.config.ts packages/agent-bundle/tests/route-invocation-dev-server.test.ts
```

Results: 4 unit tests and 1 integration test passed.

TraceDecay MCP discovery and its required CLI fallback were attempted before
source exploration/review, but the installed daemon socket was unavailable;
targeted source reads and the prescribed test gate were used instead.

## Open risks

- Exact provider/handler phase timings await request 3.
- Resource, prompt, timeout, and queue paths are implemented but are not
  exercised by this lane's real-server acceptance test.

## Proposed changeset line

Add Workbench route invocation endpoints with production render projections
and diagnostics AB8231, AB8232, and AB8236–AB8238 (#600).

## Follow-up

- Production `startDevServer` now constructs `RouteInvocationService` beside
  `routeManifest`, projecting `latestValidPreparedProject` through
  `testManifestFromRouteGraph` without a second discovery pass. Both services
  refresh from the same prepared-project closure after successful preparation.
- Foreground shutdown now closes the invocation service, aborts active render
  children, drains pending invocations, and reports cleanup failures.
- The integration test no longer injects a service through the foreground
  testing seam. It invokes tool, event, CLI, and script routes through the
  production server path; the unit test also proves active render shutdown.
