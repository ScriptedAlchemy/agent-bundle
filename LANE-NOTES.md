# L2 — Application tree model + tree view

## Files

Added:

- `packages/agent-bundle/src/dev/routes/application-tree.ts`
- `packages/agent-bundle/src/contracts/application.ts`
- `packages/agent-bundle/tests/application-tree.test.ts`
- `packages/workbench/src/application/application-tree.tsx`
- `packages/workbench/src/application/application-tree.css`
- `packages/workbench/tests/application-tree-model.test.ts`
- `packages/workbench/tests/application-tree.test.tsx`

Changed:

- `packages/workbench/src/application/application-tree-model.ts`

## Exported API

The browser-safe agent-bundle contract exports the moved `ApplicationTree`,
`ApplicationGroup`, `ApplicationServerGroup`, `ApplicationSubgroup`,
`ApplicationLeaf`, `ApplicationLeafExecution`, and `ApplicationGroupKind`
types plus:

- `applicationTreeForManifest`
- `findApplicationLeaf`
- `applicationLeafForRouteId`
- `applicationLeaves`
- `firstApplicationLeaf`
- `filterApplicationTree`

The Workbench model re-exports those types/functions and adds
`applicationTreeFor(ApplicationTreeSources)`. `ApplicationTreeView` owns its
component stylesheet directly; no global `styles.css` import is needed.

## Derivation decisions

- Group order is MCP, Events / Hooks, CLI, Scripts, Skills, Rules / Commands;
  empty top-level leaf groups and empty MCP subgroups are omitted.
- Inspection-only MCP servers remain visible as zero-leaf server nodes because
  `ApplicationNodeRef` has no server leaf identity.
- Configuration-only hooks and scripts are deduplicated across artifact
  targets, use document execution, and carry the exact description
  `configured in agent-bundle.config, no route module`.
- The current route manifest and artifact inspection contracts expose no host
  command or rule inventory. Rules / Commands is therefore omitted.

## Cross-lane requests

- L5 must mount/import `ApplicationTreeView` from
  `application/application-tree.tsx`; this lane cannot edit the shell-owned
  entry point.
- `rstest.integration-tests.ts` currently sets `workspaceTestFileGlob` to
  `packages/**/tests/**/*.test.ts`, so it silently excludes the required TSX
  component test. Change it to
  `packages/**/tests/**/*.test.{ts,tsx}` during integration. This lane ran the
  file explicitly with Rstest's `--include` option.

## Verification

- `pnpm build`
- `npx tsc --noEmit`
- `npx tsc --project packages/workbench/tsconfig.json --noEmit`
- `pnpm lint`
- 7 model/adapter tests passed.
- 3 React DOM rendering tests passed.

## Open risks

- A future manifest or artifact contract that adds command/rule records must
  project them into the existing `command` and `rule` node reference kinds.
- Empty inspection-only MCP servers intentionally have no selectable leaf
  until the shared node reference contract gains server identity.

## Proposed changeset

`Add browser-safe Application tree contracts and derivation helpers for Workbench route surfaces. (#600)`
