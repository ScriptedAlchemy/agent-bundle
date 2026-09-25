---
"@agent-bundle/runtime": minor
"agent-bundle": patch
"create-agent-bundle": patch
---

Raise the `@agent-bundle/runtime` `zod` peer floor from `^4.5.4` to `^4.6.4`: projects on `zod@4.5.x` or earlier must upgrade their direct `zod` dependency before installing the runtime, or npm rejects the required peer with `ERESOLVE`. `agent-bundle` now compiles its bundled schemas with `zod` 4.6.4, and the `cli-tool` and `mcp-server` scaffold templates pin `zod@4.6.4` to satisfy the new peer. (#842)
