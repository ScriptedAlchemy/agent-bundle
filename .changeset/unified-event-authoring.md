---
"agent-bundle": minor
"@agent-bundle/runtime": minor
---

Use `defineTool` and canonical `events` definitions with inferred handlers. Run `.ts` events without rendering, keep JSX in `.tsx` events, and gate it with `before()` using standalone execution by default; reject gate captures with `AB4840`. Resolve providers lazily with `context.provider()` instead of `config.providers` and remove `AB4841`. Remove `defineOperation`, `defineRscApplication`, `runRscCli`, `createRscMcpServer`, and public preflight exports; expose `@agent-bundle/runtime/request` for rendering-free context access.
