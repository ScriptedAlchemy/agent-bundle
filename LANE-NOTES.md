# L6 — deletions, test cleanup, Advanced-section cuts

Lane: `lane/wb600-pr1-deletions-cuts`
Worktree: `/fast/projects/agent-bundle-wt/wb600-pr1-deletions-cuts`
Base: `7a0364205` (merge-base with `wb600-pr1-shell`; this branch is an ancestor of the shell docs merge)

No changeset. Workbench is private. No `packages/agent-bundle` source edits.

## Gate

- `pnpm build` — pass (after STUBS commit; L5's `main.tsx` still imports deleted pages)
- `npx tsc --project packages/workbench/tsconfig.json --noEmit` — pass with stubs; **without** the STUBS commit, errors are only in `packages/workbench/src/main.tsx` (L5 rewrites that file):
  - `TS2307` cannot find module `./comparisons/comparison-client.ts`
  - `TS2307` cannot find module `./comparisons/comparisons-page.tsx`
  - `TS2307` cannot find module `./hooks/hooks-page.tsx`
  - `TS2307` cannot find module `./lifecycles/lifecycles-page.tsx`
  - `TS2307` cannot find module `./playground/playground-client.ts`
  - `TS2307` cannot find module `./playground/playground-page.tsx`
  - `TS2307` cannot find module `./routes/routes-page.tsx`
  - `TS2307` cannot find module `./overview-page.tsx`
  - `TS7006` Parameter `catalog` implicitly has an `any` type (`main.tsx` ~604, `playgroundClient.catalog(...).then((catalog) => ...)`)
- `pnpm lint` — pass
- Targeted unit tests — 13 files / 180 tests pass:
  `artifacts-page`, `artifacts-model`, `discovery-model`, `discovery-client`, `evals-compare`, `evals-compare-model`, `evals-page`, `hooks-model`, `lifecycles-model`, `routes-model`, `eval-client`, `comparison-client`, `project-client` (+ `route-editor-atoms-disposal` left in the integration list)

## Diff summary

Lane work (this commit, no stubs) vs `HEAD` / the merge-base with `wb600-pr1-shell`:

```
48 files changed, 585 insertions(+), 7010 deletions(-)
```

`git diff --shortstat wb600-pr1-shell...HEAD` after both commits is that plus `LANE-NOTES.md` plus the STUBS commit (re-adds the eight mount files L5 will drop).

Without stubs, `npx tsc --project packages/workbench/tsconfig.json --noEmit` errors are exactly:

```
packages/workbench/src/main.tsx(14,34): error TS2307: Cannot find module './comparisons/comparison-client.ts'
packages/workbench/src/main.tsx(15,33): error TS2307: Cannot find module './comparisons/comparisons-page.tsx'
packages/workbench/src/main.tsx(22,27): error TS2307: Cannot find module './hooks/hooks-page.tsx'
packages/workbench/src/main.tsx(24,32): error TS2307: Cannot find module './lifecycles/lifecycles-page.tsx'
packages/workbench/src/main.tsx(51,34): error TS2307: Cannot find module './playground/playground-client.ts'
packages/workbench/src/main.tsx(56,8): error TS2307: Cannot find module './playground/playground-page.tsx'
packages/workbench/src/main.tsx(64,28): error TS2307: Cannot find module './routes/routes-page.tsx'
packages/workbench/src/main.tsx(67,64): error TS2307: Cannot find module './overview-page.tsx'
packages/workbench/src/main.tsx(604,73): error TS7006: Parameter 'catalog' implicitly has an 'any' type.
```

## Deletion ledger

LOC is `wc -l` of the file at `HEAD` before this lane (the last committed original).

| file | LOC deleted | capability | where it now lives |
|---|---:|---|---|
| `src/overview-page.tsx` | 94 | Overview cards, `StateMark`, host-adoption strip, bundle-workflow dashboard | intentionally not preserved: build status + failures move into the shell header (L5). `overview-model.ts` kept (L5) |
| `tests/overview-page.test.ts` | 98 | Overview page unit tests | deleted with the page |
| `src/routes/routes-page.tsx` | 380 | Route catalog UI, input editor mount, MCP-tool prefill from the page | catalog + editor helpers stay in `routes/routes-model.ts`; L3 extracts `RouteInputEditor`. Page CSS/UI deleted |
| `src/routes/routes-page.css` | 57 | Routes page layout | deleted with the page |
| `tests/routes-page.test.ts` | 372 | Routes page unit tests | deleted; `route-editor-atoms-disposal.test.ts` now mounts a local draft editor against `routeEditorStateAtom` |
| `src/hooks/hooks-page.tsx` | 335 | Hook-simulate playground page | `canonicalHookInput` / `canonicalHookInputFor` moved into `hooks/hooks-model.ts` (same change). L3 event workspace owns simulate |
| `src/hooks/hooks-page.css` | 42 | Hooks page layout | deleted with the page |
| `tests/hooks-page.test.ts` | 244 | Hooks page unit tests | deleted with the page |
| `src/lifecycles/lifecycles-page.tsx` | 401 | Observed-receipt replay page | replay/lineage helpers stay in `lifecycles/lifecycles-model.ts`. L3 Replay tab / Trace owns the surface |
| `src/lifecycles/lifecycles-page.css` | 51 | Lifecycles page layout | deleted with the page |
| `tests/lifecycles-page.test.ts` | 155 | Lifecycles page unit tests | deleted with the page |
| `tests/lifecycles-page.browser.test.tsx` | 198 | Browser pool for the lifecycles page | deleted; removed from `rstest.integration-tests.ts` |
| `tests/fixtures/lifecycles-page-browser-fixture.tsx` | 228 | Fixture entry for that browser test | deleted with the test |
| `src/playground/playground-page.tsx` | 1104 | Script/hook/skill/MCP/native playground destination | intentionally not preserved as a page: script.run → Script leaf, hook.simulate → Event leaf, skill.inspect → Skill leaf, mcp.call-tool → Tool leaf (L3); native.prompt → Sessions (PR 3). Engine `src/runtime-playground.tsx` kept (L4) |
| `src/playground/playground-page.css` | 59 | Playground page layout | deleted with the page |
| `src/playground/playground-client.ts` | 516 | Browser client for `/api/playground/*` | server routes **kept** (see follow-up). Client deleted; STUBS commit re-adds a minimal class so `main.tsx` typechecks |
| `src/playground/playground-model.ts` | 315 | Playground presentation model | intentionally not preserved: page-only view state |
| `tests/playground-page.test.ts` | 537 | Playground page unit tests | deleted with the page |
| `tests/playground-client.test.ts` | 451 | Playground client unit tests | deleted with the client |
| `tests/playground-model.test.ts` | 153 | Playground model unit tests | deleted with the model |
| `src/comparisons/comparisons-page.tsx` | 284 | Baseline vs candidate eval comparison page | `src/evals/evals-compare.tsx` (`EvalsCompare`). `EvalsPage` has Runs · Compare tabs |
| `src/comparisons/comparisons-page.css` | 42 | Comparison page layout | `src/evals/evals-compare.css` |
| `src/comparisons/comparisons-model.ts` | 226 | Comparison presentation model | `src/evals/evals-compare-model.ts` |
| `src/comparisons/comparison-client.ts` | 197 | `/api/evals/compare` client | `src/evals/comparison-client.ts` |
| `tests/comparisons-page.test.ts` | 241 | Comparison page unit tests | `tests/evals-compare.test.ts` |
| `tests/comparisons-model.test.ts` | 285 | Comparison model unit tests | `tests/evals-compare-model.test.ts` |
| `tests/comparisons-page-client-scope-browser.test.ts` | 184 | Client-scope browser test | `tests/evals-compare-client-scope-browser.test.ts` (still listed in `rstest.integration-tests.ts`) |

No `rstest.browser*.config.ts` in this repo (only `examples/mcp-app/rstest.browser-app.config.ts`).

## Cuts (rewritten in place)

| file | old → new LOC | what was cut | what remains |
|---|---|---|---|
| `src/discovery/discovery-page.tsx` | 579 → 310 | Finding tables, bundle/store/probe dumps, redacted launch dumps, tools/list catalog | Heading **Host diagnostics**. Per host (Claude Code, Codex, Cursor): installed · version · executable path · current-plugin attach (epoch/proxy) · actionable errors with existing Re-run buttons · one MCP handshake indicator |
| `src/discovery/discovery-model.ts` | 263 → 171 | Presentation builders that only fed those dumps | `hostDiagnosticsViewFor` (replaces `hostDiscoveryViewFor`). Client decoders in `discovery-client.ts` **not** trimmed — server still sends the full report |
| `src/artifacts/artifacts-page.tsx` | 288 → 274 | Runtime hook / MCP server tables | Heading **Artifact**. Default tree is path + size; per-file Details toggle shows hash / mode / provenance. Target selector + epoch compare kept (bytes only) |
| `src/artifacts/artifacts-model.ts` | unchanged API | Tables no longer rendered | `artifactRuntimeViewFor` still exported for the tree lane / `ArtifactInspection` |
| `src/evals/evals-page.tsx` | +Runs/Compare tabs | — | Optional `comparisonClient`. Compare without a client: “Comparison client is not available in this session.” |

## Kept modules — production importer check

`git grep -l '<stem>' -- ':!repos'` after the deletions:

| module | production importer | note |
|---|---|---|
| `hooks/hook-client.ts` | `main.tsx`, `application/workspace-contracts.ts` | keep |
| `hooks/hooks-model.ts` | **none** (tests only) | keep for **L3** event workspace (`hookOptionsFor`, `canonicalHookInput*`, row helpers) |
| `lifecycles/lifecycle-client.ts` | `main.tsx`, `application/workspace-contracts.ts` | keep |
| `lifecycles/lifecycles-model.ts` | **none** (tests only) | keep for **L3** Replay tab (`lifecycleOptionsFor`, lineage/replay-source helpers) |
| `routes/routes-model.ts` | `main.tsx`, `mcp/mcp-page.tsx`, `application/application-tree-model.ts`, `workbench-capabilities.ts`, `routes/route-editor-atoms.ts` | catalog + `createRouteInputDraft` / `validateRouteInput` / schema helpers kept. Navigation prefill (`mcpToolPrefillFromNavigationState`, `mcpToolPrefillNavigationState`) kept because `main.tsx` still imports them — **L5** should drop both with hash routing |
| `routes/route-manifest-client.ts` | `main.tsx`, `workbench-capabilities.ts` | keep |
| `routes/route-editor-atoms.ts` | **none** (tests + integration fixture only) | keep for **L3** `RouteInputEditor` |
| `discovery-client.ts` / `discovery-model.ts` / `discovery-page.tsx` | `main.tsx` + page | keep; L5 remounts the same `DiscoveryPage` as Host diagnostics |
| `artifacts-page.tsx` / `artifacts-model.ts` / `artifact-client.ts` | `main.tsx` + page | keep; L5 remounts as Artifact |
| `evals/comparison-client.ts` / `evals-compare.tsx` | `evals-page.tsx` | keep. `main.tsx` still imports the old `comparisons/` path until L5 |

Symbols git-grepped before removal from models: page-only view-state (`hookPlaygroundViewFor`, `lifecyclesViewFor`, playground view helpers) had no remaining importer.

## Playground server routes — follow-up, not deleted

`packages/agent-bundle/src/dev/playground/playground-routes.ts` still serves (evidence: `route()` at ~122–137 and tests):

- `GET /api/playground`
- `GET /api/playground/catalog`
- `POST /api/playground/runs`
- `POST /api/playground/runs/:id/cancel`
- `GET /api/playground/sessions/:id`
- `GET …/export` · `GET …/replay` · `GET …/stream` · `POST …/draft-eval`

Still used by agent-bundle tests (`playground-routes.test.ts`, `playground-orchestration-service.test.ts`, `dev-workbench.test.ts`, `packed-consumer.test.ts`, `hook-playground-service.test.ts`, `script-playground-service.test.ts`), `foreground-server.ts`, `playground-orchestration-service.ts`, `contracts/playground.ts`, plus workbench e2e (`playground-real.e2e.test.ts`, `packed-release.e2e.test.ts`, `tests/support/packed-outage-ledger.ts`). **Leave them.** `/api/hooks` and `/api/lifecycles` stay for `hook-client` / `lifecycle-client`.

## Do-not-edit references (L9 / L10 own these)

`packages/workbench/tests/support/**` has no `#hooks` / `#routes` page-name hits. Leave these files alone:

- `tests/workbench-screen.test.ts` — `#hooks`, `#routes`, `#lifecycles` hash routing
- `tests/examples-real.e2e.test.ts` — `#overview`, `#playground-*`, `.routes-page-heading`, `workbenchPageLabel`
- `tests/playground-real.e2e.test.ts` — `#playground`, `#playground-*` controls
- `tests/overview.e2e.test.ts` — `#overview`, “Runtime Playground”
- `tests/packed-release.e2e.test.ts` — `#playground-*`, `#comparisons`
- `tests/mcp-app-real.e2e.test.ts` — `#overview`, “Runtime Playground”
- `tests/runtime-playground*.e2e.test.ts` / `tests/runtime-playground.test.ts` — “Runtime Playground” (engine kept)
- `tests/support/packed-outage-ledger.ts`, `tests/support/example-acceptance.ts` — `/api/playground/*`
- `packages/agent-bundle/tests/workbench-surface.test.ts` — `workbenchPageLabel`
- `packages/agent-bundle/tests/prepack.test.ts` — `#hooks/*` is an **import map**, not a Workbench hash

## Cross-lane requests

**L5 (`main.tsx`, `workbench-screen.tsx`, `workbench-capabilities.ts`)**

- Drop imports of deleted pages (`overview-page`, `routes-page`, `hooks-page`, `lifecycles-page`, `playground-*`, `comparisons/*`).
- Drop the STUBS commit on integration (`STUBS (drop on integration)`).
- Mount `EvalsPage` with `comparisonClient` so Compare is live; import `ComparisonClient` from `evals/comparison-client.ts`.
- Host diagnostics = existing `DiscoveryPage`. Artifact = existing `ArtifactsPage`.
- Drop `mcpToolPrefillFromNavigationState` / `mcpToolPrefillNavigationState` with hash routing.
- `EvalsScreen` today does `<EvalsPage client={evalClient} />` without `comparisonClient` — wire it when ComparisonsScreen goes away.

**L3 (event / route workspace)**

- Import `hooks-model` + `hook-client`, `lifecycles-model` + `lifecycle-client`.
- Import `routes-model` editor helpers + `route-editor-atoms.ts` (no production importer after the Routes page deletion).
- `canonicalHookInput` / `canonicalHookInputFor` live in `hooks-model.ts` now, not `hooks-page.tsx`.

**L4**

- `src/runtime-playground.tsx` and `tests/runtime-playground*.test.ts` were not touched. Keep the engine; delete only the destination.

**L9 / L10**

- Rewrite e2e / `workbenchPageLabel` / hash URLs listed above. Do not edit them in this lane.

## STUBS commit (drop on integration)

Second commit titled `STUBS (drop on integration)` re-adds empty mounts so rsbuild/`main.tsx` still compile until L5 lands:

- `src/overview-page.tsx` — `StateMark`, `HostAdoptionSection`, `BundleWorkflow`
- `src/routes/routes-page.tsx` — `RoutesPage`
- `src/hooks/hooks-page.tsx` — `HooksPage`
- `src/lifecycles/lifecycles-page.tsx` — `LifecyclesPage`
- `src/playground/playground-client.ts` — `PlaygroundClient({ foreground }).catalog(epochId, signal)`
- `src/playground/playground-page.tsx` — `PlaygroundPage`, `createPlaygroundCatalogLifecycle`, `playgroundScriptsForEpoch`
- `src/comparisons/comparison-client.ts` — re-export from `evals/comparison-client.ts`
- `src/comparisons/comparisons-page.tsx` — `ComparisonsPage = EvalsCompare`

These are not the delivered pages.

## Proposed changeset line (integrator)

None. Workbench is private; this lane did not change a publishable package.
