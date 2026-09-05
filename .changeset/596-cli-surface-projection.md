---
"agent-bundle": minor
---

Reserve `.cli.{ts,tsx}` under `src/mcp/**` for the opt-in CLI surface projection of a generated tool: a colocated `<tool>.cli.ts` exporting `CliProjectionConfig` (`agent-bundle/routes`) and an optional synchronous `mapInput` compiles to an idiomatic command (`inspect --routes` shows `cli.commands[].projection`) and excludes that tool from the bulk `routes.mcpCommands` projection. The bulk `routes.mcpCommands` projection now runs tools with `invocation.kind: 'cli'` (same as explicit projections; the generated MCP server still passes `kind: 'tool'`). Orphan or misplaced modules are `AB4843`, an invalid projection contract is `AB4844`, and a grammar that does not bind to the tool's contract is `AB4845` (#616).
