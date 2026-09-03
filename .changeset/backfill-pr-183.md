---
"agent-bundle": patch
---

Ship the `agent-bundle` package manifest without a `workspace:*` devDependency on `@agent-bundle/runtime`, which npm refused to install; the optional peer is satisfied through a workspace override instead. (#183)
