# Lane A3 — P1-C epoch pinning + `stateRoot`

## Files

- `packages/agent-bundle/src/dev/routes/route-invocation-service.ts`
- `packages/agent-bundle/src/dev/workbench-server.ts`
- `packages/agent-bundle/tests/route-invocation-service.test.ts`
- `docs/diagnostics.md`
- `website/docs/en/guide/development/workbench.mdx`
- `website/docs/zh/guide/development/workbench.mdx`

No new modules. `foreground-server.ts` / `route-manifest-routes.ts` / `project-service.ts` do not construct `RouteInvocationService`; the only production supplier is `workbench-server.ts`. Did not edit `route-invocation-child.ts` or A4's result assembly (`providerProjection`, `timings`, `failedInvocation`).

## Behavior

`invoke()` peeks the catalog only for 404 / request-shape checks. Inside the semaphore slot it:

1. Calls the lease-aware `prepared` supplier (acquire the snapshotted published epoch).
2. Re-reads `manifest()`.
3. Rejects with `409 AB8239` when `digest` / `sourceRevision` moved while the request waited.
4. Executes against that leased prepared project.
5. Releases the lease in `finally` (success, `AB8239`, abort, timeout, close).

The recorded `manifestDigest` / `sourceRevision` are taken from the inside-the-slot catalog, so they cannot describe a different revision than the one that ran. A queued request after a publish does not run new code under the old labels — it fails stale.

## Leasing mechanism

Production (`workbench-server.ts`): snapshot `latestPublishedPreparedProject` + `status().artifact.activeEpoch.id`, then `epochStore.acquireEpochReference(epochId)` (pins that compiled epoch; a concurrent publish cannot delete it). Return `{ project, release: () => reference.close() }`. `EPOCH_NOT_FOUND` maps to `AB8239`.

Tests may still return a bare `RouteInvocationPreparedProject`; `bindPrepared` wraps it with a no-op `release`.

Floor (also implemented, and what the queued-stale test proves): re-read after the slot is acquired and reject `AB8239` when the peeked identity moved. Used because a true "run the enqueue-time artifact" pin would require leasing *before* the wait, which the brief forbids.

## Contract changes

- `RouteInvocationPreparedProject.stateRoot: string` — `join(<projectRoot>, '.agent-bundle', 'state')` via `routeInvocationStateRoot()`; matches `pluginRootFallbackExpression` cwd fallback + `resolvePluginRoot` / `PLUGIN_STATE_DIRECTORY`. Never the code root.
- `RouteInvocationChildRequest.stateRoot: string` — passed through in `invoke()`.
- `prepared` may return a project, a `{ project, release }` lease, or a `Promise` of either.
- New: `RouteInvocationPreparedLease`, `ROUTE_INVOCATION_STALE_REVISION_CODE` (`AB8239`), `ROUTE_INVOCATION_STALE_REVISION_MESSAGE`, `routeInvocationStateRoot`.

These types are not exported from `src/index.ts`.

## Cross-lane requests

- **A2** (`route-invocation-child.ts`): read `request.stateRoot` as the session-state mount. The field is already on `RouteInvocationChildRequest` and filled by `invoke()`. Do not add it again.
- **A4**: leave the top of `invoke()`, the constructor/`prepared` contract, and the `finally` lease release alone. `manifestDigest` / `sourceRevision` already close over the inside-the-slot `manifest`.

## Open risks

- Child still Jiti-imports live source until A2 executes the leased epoch's compiled artifact. The lease keeps that epoch's directory from being deleted mid-run; A2 must actually load from it.
- Peek-then-wait `AB8239` is conservative: a queued request after a publish must be retried. Preferred pin-old-and-run was not used because the lease is acquired inside the slot.
- Sequential `prepared()` then `manifest()` inside the slot can still interleave with `onPublishedProject`. If they disagree, `AB8239` fires (manifest is compared to the enqueue peek).
- A4 merge: extra `try` / `finally` wraps the existing result assembly; those lines were not rewritten.

## Verification

- `pnpm build` — pass
- `npx tsc --noEmit` — pass
- `npx tsc --project packages/workbench/tsconfig.json --noEmit` — pass
- `pnpm lint` — pass (1389 files)
- `pnpm test:unit` — pass (4124 tests; includes `route-invocation-service.test.ts`)
- Integration: `route-invocation-dev-server.test.ts` (2) + `audiobook-curator.acceptance.e2e.test.ts` (1) — pass

TraceDecay MCP/daemon were unavailable this session; exploration used the brief's named files.

## Proposed changeset line

`patch` — Reject a queued Workbench route invocation with 409 `AB8239` when the published revision moves before it runs, and pin in-flight invocations to a leased compiled epoch. (`#600`)

Integrator owns the single PR changeset (A4). Do not add a second `.changeset` file from this lane.

## Diagnostic codes

- **`AB8239`** (new, 409): published `manifest.digest` / `sourceRevision` moved while the request waited for a concurrency slot, or the snapshotted epoch could not be leased (`EPOCH_NOT_FOUND`).
- `AB8231`, `AB8232`, `AB8236`–`AB8238` unchanged. `AB8233`–`AB8235` untouched.
