---
"agent-bundle": minor
---

Reserve `.cli.{ts,tsx}` under `src/mcp/**` for the opt-in CLI surface projection of a generated tool: a colocated `<tool>.cli.ts` exporting `CliProjectionConfig` (`agent-bundle/routes`) and an optional synchronous `mapInput` compiles to an idiomatic command (`inspect --routes` shows `cli.commands[].projection`) and excludes that tool from the bulk `routes.mcpCommands` projection. Orphan or misplaced modules are `AB4840`, an invalid projection contract is `AB4841`, and a grammar that does not bind to the tool's contract is `AB4842` (#616).
