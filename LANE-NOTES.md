# L9 — browser/e2e acceptance (PR 1)

Lane: `lane/wb600-pr1-browser-acceptance` · worktree `wb600-pr1-browser-acceptance`

Phase 1: suites rewritten against the new URL model and IA. They compile and
`inspectWorkbenchSurface` dry-runs. They cannot pass against the current hash
UI — the integrator re-dispatches this lane for phase 2 on the integrated branch.

## Files added

- `packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts` — 1440×900
  flagship acceptance (registered in `rstest.integration-tests.ts`
  `integrationTestFiles`).
- `packages/workbench/tests/support/workbench-surface.ts` — codes against L10's
  `inspectWorkbenchSurface(root).application` + `workbenchLeafPath(leaf)`. Until
  L10 lands, derives an `ApplicationTree` from the current catalog so the
  helper still dry-runs (50 curator leaves, `search_audible` →
  `/routes/mcp/curator/tool/search_audible`).
- `packages/workbench/tests/support/workbench-acceptance.ts` — primary-nav,
  tree, idle, epoch, rendered-document helpers.

## Files changed

- `packages/workbench/tests/support/workbench-e2e.ts` — `workbenchUrl` is
  path-based; leftover hash-page names map to PR 1 destinations;
  `waitForWorkbenchIdle(page)` waits out loading before any assertion.
- `packages/workbench/tests/support/example-acceptance.ts` —
  `waitForSettledWorkbench` delegates to `waitForWorkbenchIdle`; captures
  record pathname+search instead of `#hash`.
- `packages/workbench/tests/examples-real.e2e.test.ts` — rewritten to
  Application tree / Advanced / Problems (no Overview, Routes, Hooks,
  Playground, Skills pages).
- Remaining `packages/workbench/tests/*.e2e.test.ts` — navigation retargeted
  (`/advanced/{evals,artifact,protocol,hosts,logs}`, `/`, `/problems`,
  `/routes/events/tool/after`). Old-page form selectors (`#runtime-input-raw`,
  `#playground-operation`, `#mcp-target`, …) are left in the large
  runtime/playground/MCP journeys; they will fail until those capabilities
  live on the route workspace / Protocol inspector.
- `rstest.integration-tests.ts` — added the acceptance file. There is no
  `rstest.e2e*.config.ts`; Workbench browser e2e is the integration pool.

## Files not touched (other lanes)

- Lifecycles-page fixtures (`packages/workbench/tests/fixtures/lifecycles-page-browser-fixture.tsx`) — L6 deletes.
- `packages/agent-bundle/src/test/workbench.ts` — L10 owns
  `inspectWorkbenchSurface` / `workbenchLeafPath`. No stub commit; the
  support adapter is the temporary seam.

## data-testid contract (UI lanes / integrator must mount)

| testid | Role |
| --- | --- |
| `workbench-nav` | Primary nav. Exactly four links: Application · Trace · Problems · Advanced. Current area `aria-current="page"`. |
| `workbench-loading` | Present only while a route/workspace is loading. Must be gone before assertions/screenshots. |
| `application-tree` | The Application `role="tree"`. Groups in fixed order (empty omitted): MCP · Events / Hooks · CLI · Scripts · Skills · Rules / Commands. Every compiled leaf is a `treeitem` named with `leaf.label`. |
| `route-workspace` | Selected-leaf workspace (input + Run + result tabs). |
| `route-run` | Run button. Also acceptable: `getByRole('button', { name: 'Run' })`. |
| `result-tab-rendered` | Default result tab. |
| `result-tab-structured` | Structured result tab. |
| `result-tab-raw` | Raw AgentDocument tab. |
| `result-tab-mcp` | MCP projection tab. |
| `result-tab-cli` | CLI projection tab (when available). |
| `result-tab-trace` | Per-invocation trace tab. |
| `rendered-document` | Rendered Agent Document root. Non-empty; no `[data-kind="error"]` / `.agent-document-error` on success. |
| `shell-build-status` | Header build state + epoch. Text must change when a watcher rebuild publishes. |
| `problems-badge` | Header failure count linking to `/problems`. Numeric when stale/failed. |
| `problems-banner` | Problems (or Application) stale-catalog banner. |
| `problems-repair` | Repair / Rebuild control on Problems. Posts `/api/project/rebuild` (or the L5 equivalent). Also acceptable: `getByRole('button', { name: /Repair|Rebuild/ })`. |
| `inspector-toggle` | Opens the right inspector (Source · Schema · …) **and** the per-file Artifact details toggle (hashes/modes/provenance). |
| `unknown-route` | Message when `parseWorkbenchLocation` falls back to `/` for an unknown path. Also acceptable: `role="status"` containing "unknown route/path". |

Schema editor fields stay `getByLabel` (e.g. `/^title/i` for `search_audible`).

## What needs the integrated UI to run

Everything that drives Chrome against the new IA:

- Primary nav of four items (current rail is still Overview / Routes / …).
- Pathname routing + SPA fallback (`isWorkbenchShellPath`) so
  `/routes/mcp/curator/tool/search_audible` and `/advanced/evals` serve
  `index.html`.
- Application tree + route workspace (Run, Rendered default, projection tabs).
- Header epoch + Problems badge/banner/Repair.
- Unknown-path message on `/`.
- `/advanced/evals` Runs · Compare tabs; `/advanced/hosts` reduced diagnostics;
  `/advanced/artifact` file tree + details toggle.
- `?invocation=<id>` written after Run and restored on refresh.

Phase 2 should run, after `pnpm build`:

```
npx rstest --config rstest.integration.config.ts \
  packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts \
  packages/workbench/tests/examples-real.e2e.test.ts
```

Do not chase old-page assertions in `overview.e2e` / `runtime-playground*.e2e` /
`playground-real.e2e` / `mcp-app-real.e2e` until those files are finished
against the workspace (or deleted once the acceptance + examples-real cover
the capability).

## Expected runtime (phase 2)

- `audiobook-curator.acceptance.e2e.test.ts`: one test, timeout 240s × timeScale.
  Expect ~2–4 min when the example build + `search_audible` + HMR + stale
  repair all run (Audible search may need network).
- `examples-real.e2e.test.ts`: four tests, 90–150s each. Full file ~6–10 min.
- Remaining retargeted e2e files keep their existing budgets.

## Cross-lane requests

- **L5 shell**: mount the testid contract; unknown-path status; header epoch +
  failure count; Problems Repair.
- **L3 workspace**: `route-workspace`, `route-run`, result tabs,
  `rendered-document`; write `?invocation=` after a run.
- **L2 tree**: `application-tree` / `role=tree`; include config-declared
  hooks/scripts/skills (not only compiled catalog routes). Group labels must
  match `MCP`, `Events / Hooks`, `CLI`, `Scripts`, `Skills`, `Rules / Commands`.
- **L10**: add `application: ApplicationTree`, `advanced`, and
  `workbenchLeafPath(leaf)` on `inspectWorkbenchSurface`. Integrator: rewire
  e2e imports from `tests/support/workbench-surface.ts` to
  `agent-bundle/src/test` and delete the adapter.
- **L1**: SPA fallback already specified; deep links 404 without it.

## Phase 1 verification (this lane)

- `npx tsc --project packages/workbench/tsconfig.json --noEmit` — pass.
- rslint on rewritten files — pass.
- `npx rstest --config rstest.unit.config.ts packages/agent-bundle/tests/workbench-surface.test.ts` — 14/14.
- Adapter dry-run on `examples/audiobook-curator`: `leafCount=50`, groups
  `MCP`, `CLI`, `search_audible` path
  `/routes/mcp/curator/tool/search_audible`.

No changeset (Workbench is private). Integrator owns the single PR changeset
if `packages/agent-bundle` test exports change under L10.

## Proposed changeset line (for L10 / integrator, not this lane)

Rewrite `inspectWorkbenchSurface` to return `{ application, routes, lifecycles, counts, advanced }` and add `workbenchLeafPath`; remove `WorkbenchPageName` / `workbenchPageLabel` / `pages` (`#600`).
