# Task 9C: Integrated Inspector report

## Delivered contract

- The Workbench rail and page union no longer expose Inspector as a peer page.
- MCP owns an internal, accessible Playground / Inspector tab control. Both tab panels stay mounted and are hidden and inert when inactive, so switching does not recreate either presentation.
- `McpPage` and `InspectorSessionAdapter` share the existing controller; the adapter receives the app-level subscription of that same controller model. No second transport, session, bootstrap, route client, or iframe was introduced.
- `#inspector` is a one-way alias: it selects Inspector, replaces the URL with `#mcp`, and does not add a history entry. Direct `#mcp` and the rail MCP action select Playground. Internal tabs leave browser history unchanged.
- The responsive tab shell keeps the 390 px page width within the viewport.

## TDD evidence

- RED: the dedicated-Inspector Chrome fixture was first rewritten to require canonical `#mcp`, no Inspector rail link, a selected internal Inspector tab, idle/no POST, and the shared real-session flow. The pre-change dedicated page retained `#inspector` and had no internal Inspector tab.
- GREEN: the same real Chrome fixture now verifies the alias, one POST, exact shared Inspector catalogs/protocol/logging, preserved Playground form state, reset propagation, no page errors, and 390 px overflow.

## Verification

- `npm exec rstest -- run packages/workbench/tests/inspector-shell.e2e.test.ts --reporter verbose` — 3 Chrome tests passed: production alias/session flow and explicit development artifact.
- `npm exec rstest -- run packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/inspector-session-adapter-fixture.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-page.test.ts --reporter verbose` — 47 tests passed.
- `npm run typecheck --workspace agent-bundle-workbench` — passed.
- `npx rslint packages/workbench/src/main.tsx packages/workbench/tests/inspector-shell.e2e.test.ts` — 0 errors, 0 warnings.
- `npm run build --workspace agent-bundle-workbench` and `git diff --check` — passed.
- TraceDecay package diagnostics — 0 errors, 0 warnings; simplify scan — no findings (the index noted only `styles.css` stale); unsafe-pattern scan — 0 matches; test-risk scan — no items.
- Code-simplifier and deslop review — no behavior-preserving cleanup needed.

## Scope guard

No Inspector vendor/adapter source, export wiring, MCP launch/timeout/App logic, backend routes, or evaluator files changed.

## Fix round 1: complete tab semantics

- RED: the expanded real Chrome session contract failed because the selected Playground tab had no `tabindex="0"`; ArrowRight therefore did not move focus or select Inspector.
- GREEN: the two internal tabs now use roving `tabIndex` and select/focus through ArrowLeft, ArrowRight, Home, and End without mutating browser history.
- The existing Chrome fixture now also proves exactly one mounted panel of each kind, inactive `hidden` + `inert` state, selected-panel exposure, stable history through keyboard and pointer switches, retained Inspector Logging state after a Playground roundtrip, and no horizontal overflow for either presentation at 390 px.
- Verification: Inspector Chrome fixture 3/3; focused Inspector adapter/controller/page suite 47/47; Workbench typecheck, scoped Rslint, production Rsbuild, and `git diff --check` all passed. Code-simplifier/deslop found no cleanup needed.
