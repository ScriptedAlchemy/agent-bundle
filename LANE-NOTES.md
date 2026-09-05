# wb600 PR 1 — integration wiring lane

Branch: `lane/wb600-pr1-wiring`  
Base: `wb600-pr1-shell` (`13fd6eda3`)

## Rewired

- Consolidated Advanced → Evals on L6's `EvalsPage`, passing its optional
  `comparisonClient`; removed L5's duplicate Runs / Compare tab state and all
  remaining `comparisons/*` imports.
- Rewired the kept Runtime controller, event buffer, and retry plan to
  `runtime-controller.ts`.
- Rewired MCP App preview and Protocol page contracts to
  `runtime-view-contracts.ts`. Its `RuntimeAppPreviewProps` already retained
  the consumer-required `run`, `profile`, `profileId`, `surface`, and
  `registerLifecycle` fields, so no contract restoration was necessary.
- Added `contracts/workbench-shell.ts` as the browser-safe re-export surface
  for application-node and Workbench-shell path contracts; Workbench source
  no longer imports `agent-bundle/src/dev/**`.
- Confirmed `application/invocation-client.ts` imports invocation wire types
  through `contracts/invocations.ts`.
- Updated `ApplicationTree` fixtures from the removed catalog literal
  `current` to the real tree state literal `fresh`.
- Expanded `workspaceTestFileGlob` to
  `packages/**/tests/**/*.test.{ts,tsx}`. The only currently present
  Workbench `.test.tsx` file is `application-tree.test.tsx`, which is intended
  for the unit pool.
- Added the acceptance test IDs `workbench-loading`, `unknown-route`, and
  `application-tree`.
- Removed the old Routes-page MCP-prefill navigation envelope and helper
  family while retaining `McpToolPrefill` for `McpPage` and retaining the
  catalog/input/schema helpers required by the route workspace.

## Deleted

Fully deleted files and their original LOC:

| File | LOC |
| --- | ---: |
| `src/mcp/runtime-mcp-handoff.ts` | 480 |
| `src/mcp/runtime-consent-dialog.tsx` | 99 |
| `src/mcp/runtime-consent-queue.ts` | 73 |
| `src/skills-page.tsx` | 467 |
| `src/skills-eval-coverage.ts` | 72 |
| `tests/runtime-mcp-handoff.test.ts` | 518 |
| `tests/runtime-consent-dialog.test.ts` | 154 |
| `tests/runtime-consent-queue.test.ts` | 55 |
| `tests/skills-page.test.ts` | 270 |
| `tests/skills-eval-coverage.test.ts` | 96 |

The handoff and consent presentation modules had no production importer after
L5 removed Runtime ↔ MCP page handoff wiring. `runtime-app-bridge.ts` remains:
`mcp-app-preview.tsx` is its production importer. The typed MCP App client's
own runtime-consent protocol coverage remains in `mcp-app-client.test.ts`
without depending on the deleted UI queue.

Also removed 129 lines of page-only global CSS for Runtime Playground/stage/
inspector/consent and the standalone Skills shell/tree. Skill document and
Markdown styles remain for L3 reuse; no `.skill-document-panel*` rules were
removed.

## Left for L3

- `packages/workbench/src/application/route-workspace.tsx` is intentionally
  absent. It is the only remaining Workbench TypeScript/build error.
- Did not touch any L3-owned route workspace, rendered document, input editor,
  inspector, result tabs, event/app/skill workspace, skill document panel,
  workspace CSS/contracts, Skills-page replacement, or agent-document-stage
  file.
- Preserved `hooks/hooks-model.ts`, `lifecycles/lifecycles-model.ts`,
  `routes/route-editor-atoms.ts`, `runtime/agent-document-atoms.ts`, and
  `runtime/agent-document-client.ts` for L3's imports.

## Verification

- `pnpm install --frozen-lockfile --prefer-offline` — pass.
- `npx tsc --noEmit` — pass.
- `pnpm lint` — pass (1,331 files).
- `npx tsc --project packages/workbench/tsconfig.json --noEmit` — only:
  `main.tsx(21,32): Cannot find module './application/route-workspace.tsx'`.
- Targeted unit tests — 12 files, 174 passed.
- `mcp-page-app-browser.test.ts` — 6 passed.
- `pnpm build` — reaches `build:workbench` and stops only because L3's
  `application/route-workspace.tsx` is absent.
- `rstest-pool-lists.test.ts` additionally exposed a pre-existing stale
  `nightlyEvidenceTestFiles` entry for the already-deleted
  `runtime-playground-capture.test.ts`. Fixing or retiring
  `rstest.evidence.config.ts` is outside this lane's owned files. The stale
  integration-list entries for deleted Runtime tests were removed.

## Proposed changeset line

`Expose browser-safe Workbench shell paths and application-node contracts for the redesigned Workbench. (#PR)`
