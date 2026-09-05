# L10 — public Workbench test surface

## Changed

- Replaced `agent-bundle/test` page availability with `application: ApplicationTree` and content-bearing `advanced` sections.
- Added `workbenchLeafPath(leaf)` and public application-tree type exports.
- Removed `WorkbenchPageName`, `workbenchPageLabel`, `workbenchPagesFor`, `pages`, and `unavailablePages`.
- Kept the route catalog, manifest, lifecycle replay inventory, capability counts, provenance, CLI usage projection, and rendered-Skill inspection proof.
- Reworked the Workbench-surface unit, route-unit, and dev-server integration assertions around groups, leaves, paths, and Advanced availability.
- Updated Workbench walkthrough wording in `examples/skills-starter`, `examples/mcp-app`, `examples/host-test`, `examples/hooks-and-scripts`, and `examples/rsc-agent-runtime`.
- No matching Workbench-page wording required changes under `packages/create-agent-bundle/**` or production `packages/agent-bundle/src/dev/**`.

## Exported API

- Added `AdvancedSection`.
- Added `workbenchLeafPath`.
- Re-exported `ApplicationTree`, `ApplicationGroup`, `ApplicationServerGroup`, `ApplicationSubgroup`, `ApplicationLeaf`, and their kind/execution types from `agent-bundle/test`.
- `inspectWorkbenchSurface` now returns `application` and `advanced` instead of page lists.

## Cross-lane requests

- Update `packages/workbench/tests/examples-real.e2e.test.ts`: it still imports `workbenchPageLabel` and reads `surface.pages` / `surface.unavailablePages`. Replace those rail assertions with the PR 1 Application-tree/shell assertions owned by the Workbench lanes.
- Drop the final `packages/agent-bundle/src/dev/routes/application-tree.ts` stub commit when integrating L2's implementation.

## Open risks

- The local tree implementation is intentionally an integration stub. L2's implementation is authoritative; retain L10's caller and tests while resolving any final tree-label or source-shape differences.
- The required literal grep still reports private `#hooks` fields and `.cursor-plugin/plugin.json#hooks` manifest anchors. They are JavaScript private names / artifact pointers, not old Workbench hash routing or page wording, so they were not changed.

## Verification

- `pnpm install --frozen-lockfile --prefer-offline && pnpm build`
- `pnpm build && npx tsc --noEmit`
- `pnpm lint`
- `npx rstest --config rstest.unit.config.ts packages/agent-bundle/tests/workbench-surface.test.ts`
- `npx rstest --config rstest.route-unit.config.ts packages/agent-bundle/tests/route-unit/workbench-surface-rendered-skill.test.ts`
- `npx rstest --config rstest.integration.config.ts packages/agent-bundle/tests/workbench-surface-dev-server.test.ts`

## Proposed changeset

`minor` — Replace `inspectWorkbenchSurface` page availability with the Application tree and Advanced sections, add `workbenchLeafPath`, and remove `WorkbenchPageName`, `workbenchPageLabel`, and `workbenchPagesFor` (#600).
