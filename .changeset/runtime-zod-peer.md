---
"@agent-bundle/runtime": minor
"create-agent-bundle": patch
---

Declare `zod` as a `^4.5.4` peer dependency of `@agent-bundle/runtime` instead of an exact `4.5.4` dependency, so a project and the runtime share one installed Zod copy. Zod 4 brands schema types by minor version; with the nested copy, a project on `zod@4.6.x` failed to typecheck any schema it passed to `defineState` or a route (`Type '6' is not assignable to type '5'`). Projects pinned below `zod@4.5.4` must upgrade: the floor excludes the 4.5.0–4.5.3 default-factory regression the runtime already required 4.5.4 to avoid. The `cli-tool` and `mcp-server` scaffold templates pin `zod@4.5.4` to satisfy the peer (#793)
