# Lane A4 — P2 telemetry honesty

## Files

- `packages/agent-bundle/src/dev/routes/route-invocation.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation-service.ts`
- `packages/agent-bundle/tests/route-invocation-service.test.ts`
- `packages/agent-bundle/tests/route-invocation-dev-server.test.ts` (assertion only; integration pool not run)
- `packages/workbench/src/application/invocation-client.ts`
- `packages/workbench/src/application/runtime-backend.ts`
- `packages/workbench/src/application/workspace.css`
- `packages/workbench/tests/invocation-client.test.ts`
- `packages/workbench/tests/route-workspace.test.ts`
- `website/docs/en/guide/development/workbench.mdx`
- `website/docs/zh/guide/development/workbench.mdx`
- `.changeset/wb600-pr2a-telemetry.md`

Not edited (no decoder/view of invocation `providers`/`timings` beyond pass-through): `invocation-model.ts`, `result-tabs.tsx`. Inspector Providers/Timings already omitted absent `durationMs`; status now includes `unobserved` via the CSS class.

## Behavior

- Success without `child.observed`: every catalog provider is `{ id, name, status: 'unobserved' }` with no `durationMs`. Timings are only measured `render` (`child.renderDurationMs`) and `projection` (service wall time). No `handler` / `providers` / `provider:*` rows.
- Success with `child.observed`: `providers` are the observed rows exactly. Observed timings that are `handler`, `providers`, or `provider:*` are forwarded; an observed `render` is dropped so the service's `child.renderDurationMs` remains the `render` phase.
- Failure: no fabricated `failed` providers — same unobserved catalog rows. The only timing is `elapsed`: wall time from the recorded `startedAt` (before the semaphore slot) until the child/script threw. That is not render time; `render` is omitted because no document was produced.
- Workbench decoder accepts `'unobserved'` and optional `durationMs`. Providers tab shows status `unobserved` and `—` when duration is absent. Runtime-backend no longer coerces missing span durations to `0`.

## Exported API / contract

- `RouteInvocationProviderStatus` adds `'unobserved'`.
- `RouteInvocationProvider.durationMs` stays optional (now documented: absent = not measured).
- `RouteInvocationTiming.phase` documents `elapsed` and that zero is a measurement.
- `RouteInvocationChildResult.observed?: { providers; timings }` added (agreed A2/A4 shape). A2 may add the same field — accept the trivial conflict.
- `RouteInvocation` / `RouteInvocationProvider` are **not** exported from `src/index.ts` or another public package entry (`package.json` `exports` has no `./contracts`). `src/contracts/invocations.ts` re-exports them for the Workbench source import only. Changeset is **patch**.

## Cross-lane requests

- **A2** (`route-invocation-child.ts`): populate `RouteInvocationChildResult.observed` with measured provider rows and `handler`/`providers`/`provider:*` timings. When that lands, `packages/agent-bundle/tests/route-invocation-dev-server.test.ts` currently expects the clock provider `unobserved` and timings `['render', 'projection']` — flip those assertions to the observed values.
- **A3**: none. `invoke()` ordering, `prepared`, and the constructor were left alone.

## Open risks

- Until A2 emits `observed`, every live Workbench run shows catalog providers as `unobserved`. That is honest, not a regression of measurement.
- `elapsed` is a new phase name on failures. The Timings tab will render it as a real bar (including `0 ms` if `now()` does not advance).
- `startedAt` for the success `render` timing is still the pre-semaphore invocation timestamp; only the duration is the child's measurement.

## Verification

- `pnpm build` — pass
- `npx tsc --noEmit` — pass
- `npx tsc --project packages/workbench/tsconfig.json --noEmit` — pass
- `pnpm lint` — pass (1389 files)
- `pnpm test:unit` — pass (275 files / 4128 tests; intended file filter ran the whole unit pool)

Not run: `rstest.route-unit.config.ts`, `rstest.integration.config.ts` (`route-invocation-dev-server.test.ts` assertion updated but not executed), Workbench e2e. A4 gates did not require those.

## Proposed changeset

`.changeset/wb600-pr2a-telemetry.md` — `agent-bundle` **patch**:

> Stop fabricating route-invocation provider and timing rows. Unmeasured providers now use status `unobserved` with no `durationMs`; `handler`, `providers`, and `provider:<name>` timings appear only when the child observed them. Failures record a measured `elapsed` phase instead of invented `failed` providers or a fake `render`. (#600)

## Diagnostic codes

None. A4 takes no new codes (`AB8233`–`AB8235` browser; `AB8250`–`AB8252` A2; `AB8239` A3).
