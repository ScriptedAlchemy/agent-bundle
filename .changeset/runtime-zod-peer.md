---
"@agent-bundle/runtime": patch
"create-agent-bundle": patch
---

Declare `zod` as a `^4.5.0` peer dependency of `@agent-bundle/runtime` instead of an exact `4.5.4` dependency, so a project and the runtime share one installed Zod copy. Zod 4 brands schema types by minor version; with the nested copy, a project on `zod@4.6.x` failed to typecheck any schema it passed to `defineState` or a route (`Type '6' is not assignable to type '5'`). The `cli-tool` and `mcp-server` scaffold templates pin `zod@4.5.4` to satisfy the peer (#793)
