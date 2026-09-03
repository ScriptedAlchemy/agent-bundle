---
"agent-bundle": patch
---

Remove thirteen unreferenced modules left behind by earlier extractions that
never rewired their callers, and collapse the surviving duplicates onto their
canonical owners. `dev/eval/eval-routes.ts`, `dev/mcp-apps/mcp-app-routes.ts`,
`dev/runtime-routes.ts`, and `dev/foreground-server.ts` now use `dev/http.ts`
for `diagnostic`, `requestError`, `isRequestDiagnostic`, `responseDiagnostic`,
`responseJson`, `singleHeader`, `isJsonRequest`, `readBody`, and `rawPathname`
instead of four private copies of each; `dev/mcp-apps/mcp-app-bridge.ts` takes
`validIcons` and `validIsoDateTimeWithOffset` from
`dev/mcp-app-action-validation.ts`; and the conventional-entry probe shared by
`config/normalize.ts` and `routes/graph.ts` moves to the new leaf module
`config/conventional-entry.ts`. No public export, route, diagnostic code, or
runtime behavior changes.
