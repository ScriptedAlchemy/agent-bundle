# Task 9B: MCP session timeout report

## Delivered contract

- `timeoutMs` is selected before session open, defaults to 5,000 ms, and is stored immutably on the session rather than in `McpSessionBinding`.
- The MCP create route admits only a finite, positive own JSON number and returns the established `AB8016` invalid-shape diagnostic for invalid values or smuggled fields.
- Initialization, catalog reads, prompt/resource/tool calls, and restart resolve omitted timeouts from the session value; internal callers can still supply an explicit request override.
- Route, transport, controller, and page retain the value. The page exposes an accessible `Session timeout (ms)` control, validates locally, locks it once opening begins, and displays the exact active timeout.

## TDD evidence

- Backend RED: a create request with `timeoutMs` received HTTP 400; the opened session exposed no timeout.
- Browser RED: transport POST body omitted `timeoutMs`, controller factory options omitted it, and page markup had no labeled control.
- Chrome RED: dedicated interaction contract was written before the page control existed.
- GREEN: all contracts pass with the implementation below.

## Verification

- `npm test -- packages/agent-bundle/tests/mcp-session-service.test.ts packages/agent-bundle/tests/mcp-session-routes.test.ts` — 34 passed.
- `npm run typecheck --workspace agent-bundle-workbench` — passed.
- Scoped `npx rslint` for the five MCP sources and focused tests — 0 errors, 0 warnings.
- `npm test -- packages/workbench/tests/agent-bundle-remote-transport.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-page.test.ts` — 41 passed.
- `npx rstest --config rstest.config.ts packages/workbench/tests/mcp-session-timeout.e2e.test.ts --reporter verbose` — 1 Chrome test passed, including restart, invalid local input/no route request, no page errors, and 390 px overflow check.
- `npm run build --workspace agent-bundle-workbench` and `git diff --check` — passed.
- TraceDecay diagnostics reported 0 errors; simplify, redundancy, unsafe-pattern, and test-risk scans reported no findings in scope.

## Commits

1. `9f868fa feat(mcp): persist session request timeouts`
2. `feat(workbench): control MCP session timeouts`

## Scope guard

No per-operation browser timeout, launch-config/download, trace-export, Inspector, Playground, eval, raw-log, or broad lifecycle E2E changes were made.
