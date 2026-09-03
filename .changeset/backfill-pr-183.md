---
"agent-bundle": patch
---

The published `agent-bundle` manifest no longer carries a `workspace:*` devDependency on `@agent-bundle/runtime`, which npm refuses to install; the optional peer is satisfied through a workspace override instead. (#183)
