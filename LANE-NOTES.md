# L8 — Chinese docs mirror (`website/docs/zh/**`)

Lane: `lane/wb600-pr1-docs-zh`  
Worktree: `/fast/projects/agent-bundle-wt/wb600-pr1-docs-zh`

## Pages changed

All 19 English twins from L7 were mirrored into Simplified Chinese. Product/UI names
(Application · Trace · Problems · Advanced · Events / Hooks · Run · Rendered · Replay ·
Rebuild · Idle · Building · Failed), route paths, code, diagnostic codes, and env var names
stay in English.

- `website/docs/zh/guide/development/workbench.mdx` — full rewrite of the new Workbench
  guide (navigation, Application tree, route workspace, Trace, Problems repair, Advanced,
  URL model, invocation API, “什么变了”). Unchanged sections (programmatic session, host
  installs, Agent API, contributor HMR) kept their existing zh voice.
- `website/docs/zh/guide/development/testing.mdx` — `inspectWorkbenchSurface()` now returns
  `{ application, routes, lifecycles, counts, advanced }`; `WorkbenchPageName` /
  `workbenchPageLabel` no longer exported.
- `website/docs/zh/guide/development/evaluations.mdx` — Eval page → Advanced → Evals →
  Runs / Compare; Playground draft-case sentence removed.
- `website/docs/zh/guide/development/index.mdx` — four-area Workbench summary.
- `website/docs/zh/guide/start/quick-start.mdx` — Application tree / rendered result /
  Trace / Problems / Advanced.
- `website/docs/zh/guide/authoring/index.mdx` — Routes page → selected-leaf route inspector.
- `website/docs/zh/guide/authoring/hooks.mdx` — hook simulation under Application →
  Events / Hooks with host fixtures.
- `website/docs/zh/guide/authoring/mcp.mdx` — task controls at Advanced → Protocol; App
  preview via Application → MCP → &lt;server&gt; → Apps.
- `website/docs/zh/guide/authoring/scripts-assets.mdx` — script run under Application →
  Scripts.
- `website/docs/zh/guide/authoring/skills.mdx` — Skill leaf + inspector tabs.
- `website/docs/zh/examples/audiobook-curator.mdx` — `search_audible` rendered-route loop
  and `/routes/mcp/curator/tool/search_audible` deep link.
- `website/docs/zh/examples/hooks-and-scripts.mdx` — event/script leaves, Trace, Problems,
  Advanced.
- `website/docs/zh/examples/mcp-app.mdx` — Application leaves and Advanced protocol /
  artifact / eval views.
- `website/docs/zh/examples/skills-starter.mdx` — Skill leaves, Advanced artifact/evals,
  Problems repair.
- `website/docs/zh/index.mdx` — home-page Workbench feature and Develop step.
- `website/docs/zh/reference/cli.mdx` — Workbench App workspace (not MCP page).
- `website/docs/zh/reference/configuration.mdx` — contract-gated destination is the route
  workspace.
- `website/docs/zh/reference/limitations.mdx` — Playground product name removed from the
  pre-0.1 record warning.
- `website/docs/zh/reference/runtime-environment.mdx` — hook simulation env set by the
  event route workspace.

No `en/**` edits. No generated pages (`zh/api/**`, hosts/events/diagnostics reference).
No changeset (docs site is private).

## Verification

- `node scripts/check-locale-drift.mjs`: **0 failures** across 33 page pairs and 9 meta
  files (heading / fence / table-row / diagnostic-code / fence-body parity).
- Website `tsc --project tsconfig.json`: passed.
- `pnpm docs:site:build` failed on the known cross-lane diagnostics coverage item only
  among *authored-doc* checks: `AB8231` in
  `website/docs/en/guide/development/workbench.mdx` is not yet a documented code in
  `docs/diagnostics.md` (range `AB8233–AB8235` is already listed; `AB8231`/`AB8232` are
  not). This lane cannot register those codes.
- Isolated Rspress build (`RSPRESS_PERSISTENT_CACHE=false pnpm build` in `website/`)
  then failed on a **cross-lane TypeScript error** in
  `packages/agent-bundle/src/test/workbench.ts:270` (`inspection` missing `id` / `path` /
  `target` on hooks vs `ApplicationTreeInspectionHook`). Not owned by this lane. Link
  checker did not run because the site did not emit.

## Cross-lane requests

1. **L1 / diagnostics:** register `AB8231`–`AB8235` in `docs/diagnostics.md` so
   `check:diagnostics` accepts the Workbench invocation-API paragraph. Until then,
   `pnpm docs:site:build` fails on `AB8231`.
2. **L10 / L2:** `inspectWorkbenchSurface` passes `input.inspection` into
   `applicationTreeForManifest`, but the inspection hook shape lacks `id`, `path`, and
   `target`. TypeDoc/twoslash compile of `packages/agent-bundle/src` fails; the integrator
   must take the aligned types before the docs site can finish building.
3. **Workbench package build:** `pnpm build` in this worktree failed on
   `Can't resolve './runtime-playground.tsx'` from `packages/workbench/src/main.tsx`.
   Docs TypeDoc compiles package source and does not need that dist, but the briefed
   first-step build did not complete.

## VERIFY (English sentences carried / still doubtful)

- VERIFY: URL examples and refresh-safe shell paths
  (`/routes/mcp/<server>/tool/<name>`, `/trace/<invocation-id>`,
  `/advanced/<section>`, `?invocation=<id>`) match
  `application-node.ts` / `workbench-shell-paths.ts` / `workbench-location.ts` after
  remaining lanes land. Copied from L7.
- VERIFY: invocation envelope and `route.invocation` event, plus `AB8231`–`AB8235`
  assignments, land with L1. `docs/diagnostics.md` on this branch still documents
  `AB8233`–`AB8235` with their pre-#600 meanings.
- VERIFY: `inspectWorkbenchSurface()` return shape
  `{ application, routes, lifecycles, counts, advanced }` and the deletion of
  `WorkbenchPageName` / `workbenchPageLabel` follow the L10 contract; this lane’s
  TypeDoc compile still sees a type error on that helper.
- VERIFY: Advanced section path names `evals` / `artifact` / `protocol` / `hosts` /
  `logs` are the live `advancedSections` values.

## Exported API

None.

## Proposed changeset

None; private documentation site only.
