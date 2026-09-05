# Lane L3 — route workspace (Rendered-by-default + MCP App preview)

Branch `lane/wb600-pr1-workspace-renderer`. Everything below lives under
`packages/workbench/src/application/` unless noted.

## Delivered

| File | Role |
| --- | --- |
| `route-workspace.tsx` | `RouteWorkspace(props)` — dispatch on `leaf.execution` (`invoke` → `ExecutableRouteWorkspace` / `EventRouteWorkspace`, `preview` → `AppRouteWorkspace`, `document` → `SkillWorkspace` / `DocumentWorkspace`). Exhaustive `switch`. |
| `executable-route-workspace.tsx` | `useRouteInvocation(backends, leaf, invocationId)` (the `RouteInvocationController`), `ExecutableRouteWorkspace`, `WorkspaceHeader`, status line, diagnostics (each links to `/problems` via `onNavigate`), Run + Ctrl/⌘-Enter, last-input persistence per `leaf.key`. |
| `rendered-document.tsx` | `foldAgentDocumentEvents`, `agentDocumentNodeRenderers` (every node kind incl. progress / Suspense placeholders / `represented-error`), `RenderedAgentDocument({ events, emptyLabel? })`. Designed around `events` so a streaming backend can feed partial arrays later. |
| `route-input-editor.tsx` | Schema form · Raw JSON toggle · CLI args (`RouteManifestCliCommand` → argv preview) · fixture `<select>` · Reset. `RouteInputEditor({ leaf, value, onChange, fixtures, onRun, running })` plus pure helpers (`defaultRouteInputValue`, `routeInputValueFromJson`, `submitRouteInput`, `cliArgsFor`). |
| `result-tabs.tsx` | Rendered (default) · Structured · Raw AgentDocument · MCP projection (when `projection.mcp`) · CLI projection (when `projection.cli`) · Trace (`controller.history`; click → `controller.load(id)` + `onNavigate({ area: 'application', invocationId, node, tab: 'rendered' })`). Accepts `extraTabs` for the event codec panes. |
| `route-inspector.tsx` | Right drawer, closed by default (`data-testid="inspector-toggle"`). Tabs Source · Schema · Context · Providers · Timings · Projection · Raw protocol. Generic `InspectorDrawer` reused by the skill workspace. |
| `event-route-workspace.tsx` | Host selector Canonical / Claude / Codex / Cursor (`data-testid="event-host-<host>"`), host fixtures from `clients.lifecycleClient`, `request.event = { host, fixtureId }` when the submitted input matches a served host fixture; extra tabs Mapping · Native in/out · Canonical result · Replay (observed receipts). |
| `app-route-workspace.tsx` | MCP App preview in the centre (`McpAppPreview`, `createMcpSessionController`, `McpAppClient` — imports only, nothing under `src/mcp/**` modified). Tools bound to the App (`_meta.ui.resourceUri` from the session's tool catalog) are listed first with a `McpJsonInput` editor beside the preview. |
| `skill-workspace.tsx`, `skill-document-panel.tsx` | Moved out of `skills-page.tsx`: rendered skill document (resources tree, frontmatter, eval coverage) + inspector tabs Source/Generated diff · Frontmatter · Resources · Eval coverage. Uses `clients.skillClient` and `clients.evalClient`. |
| `workspace.css` | All workspace styling. Imported from the tsx files; **no `styles.css` change needed**. |
| `workspace-contracts.ts` | Extended — see "Contract changes". |

Deleted (tests moved): `runtime/agent-document-stage.tsx` → `rendered-document.tsx`,
`tests/agent-document-stage.test.ts` → `tests/rendered-document.test.ts`;
`skills-page.tsx` → `skill-workspace.tsx` + `skill-document-panel.tsx`,
`tests/skills-page.test.ts` → `tests/skill-workspace.test.ts`.

Tests (`packages/workbench/tests/`): `route-workspace.test.ts`, `rendered-document.test.ts`,
`route-input-editor.test.ts`, `event-route-workspace.test.ts`, `skill-workspace.test.ts`, shared
fixtures + fake backend in `tests/support/workspace-fixtures.ts`. Named `.test.ts` (not `.tsx`)
because `rstest.unit.config.ts` only globs `tests/*.test.ts`; they use `createElement` + SSR like the
existing workbench tests. 43 tests pass.

`data-testid`s mounted: `route-workspace`, `route-run`, `route-input-editor`, `rendered-document`,
`inspector-toggle`, `result-tab-<name>` for every result tab (`rendered`, `structured`, `raw`, `mcp`,
`cli`, `trace`, `mapping`, `native`, `canonical`, `replay`), `inspector-tab-<name>`, `event-host-<host>`,
`route-status`, `app-preview`.

## Gate

`pnpm build` ✓ · `pnpm lint` ✓ · lane tests 43/43 ✓ ·
`npx tsc --project packages/workbench/tsconfig.json --noEmit` → **exactly three errors, all in files
other lanes own, all caused by the deletions this lane was told to make** (see "Requests for other
lanes / integrator" — the patches are given verbatim). With those three applied, tsc is clean.

## STUBS (drop on integration)

Committed separately as `STUBS (drop on integration)`:

- `packages/workbench/src/application/invocation-model.ts` — L4 owns the real file. L3 codes against
  exactly these names/shapes:
  - `InvocationState = idle | running{correlationId,startedAt} | succeeded{invocation,durationMs?} | failed{invocation?,diagnostics,failure?,durationMs?}`
  - `InvocationAction = start | settle | fail | load | reset`; `reduceInvocationState(state, action)`; `idleInvocationState`
  - `readLastInput(leafKey): JsonValue | undefined`, `writeLastInput(leafKey, input)` (sessionStorage, key `agent-bundle.workbench.last-input:<leafKey>`)
  - `selectBackend(backends, leaf)` → first backend whose `accepts(leaf)` is true.
  If L4's real shapes differ, the only consumers are `executable-route-workspace.tsx`,
  `workspace-contracts.ts` (`invocationOf`), and the two tests that assert the reducer.

The fake `InvocationBackend` in `tests/support/workspace-fixtures.ts` is test support (it also holds
the leaf fixtures every L3 test uses) and stays; if L4 ships a shared fake, swap the import.

## Contract changes (`workspace-contracts.ts`, L3-owned)

- `WorkspaceResultTab` gains `canonical | mapping | native | replay` (event leaves only).
- `WorkspaceInspectorTab` gains `timings`.
- New: `RouteInputFixture { id, label, input, host? }`, `RouteInvocationDraft` (= request minus
  `routeId`/`correlationId`), `RouteInvocationController { state, history, request?, backendKind?, run, load }`,
  `invocationOf(state)`, `publishedEpochFor(status)`.

## Requests for other lanes / integrator

1. **L6 `lifecycles/lifecycles-page.tsx`** (if it survives; L6 deletes the page) — replace
   `import { AgentDocumentStage } from '../runtime/agent-document-stage.tsx';` with
   `import { RenderedAgentDocument } from '../application/rendered-document.tsx';` and
   `<AgentDocumentStage events={replay.events} />` with `<RenderedAgentDocument events={replay.events} />`.
2. **`runtime-inspector.tsx`** (L4/L5) — same substitution: import `RenderedAgentDocument` from
   `./application/rendered-document.tsx`; `<AgentDocumentStage events={events} />` →
   `<RenderedAgentDocument events={events} />`.
3. **L5 `main.tsx`** — drop `import { SkillsPage } from './skills-page.tsx';` and the `SkillsScreen`
   usage; skills are reached through the Application tree → `RouteWorkspace` (`execution: 'document'`,
   `ref.kind === 'skill'`).
4. **L5 shell** — mount `RouteWorkspace` from `application/route-workspace.tsx` for the selected leaf;
   it is the only production entry point for every file this lane adds. Pass `invocationId` from the
   `?invocation=` query (`shell/workbench-location.ts` already parses it) and `tab` from the location.
5. **`routes/routes-page.tsx`** (whoever deletes it) — its inline input editor is now duplicated by
   `route-input-editor.tsx`; delete the page, do not keep both.
6. **`mcp/mcp-page.tsx`** (owner of `src/mcp/**`) — export the App host-context builder
   (`browserMcpAppHost` or equivalent). `app-route-workspace.tsx` carries a private copy
   (`workbenchAppHost`) because `src/mcp/**` was read-only for this lane; delete the copy once the
   export exists. `supportedMcpAppPreviewProfiles` is already imported from there.
7. **L4 backend** — `RenderedAgentDocument` takes `events`; when a streaming backend exists, feed it the
   partial event array while `state.phase === 'running'`. Nothing else in L3 changes.

## Assumptions

- Fixtures for tools/resources/prompts come from the manifest entry when present; event leaves get one
  fixture per host from the lifecycle catalog served by `lifecycleClient`. The Canonical host has no
  fixture list; the input is sent as-is.
- The dev server's `RouteInvocation` envelope arrives whole in PR 1; the Rendered tab renders
  `invocation.document.events` as the final stream.
- The inspector's Raw protocol tab shows the last `RouteInvocationRequest` sent plus the raw
  `RouteInvocation` JSON; no separate wire capture is assumed.
- Desktop-only (1440×900); no responsive rules in `workspace.css`.
- No changeset: only `packages/workbench` (private) changed.
