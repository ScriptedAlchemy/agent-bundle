---
"agent-bundle": patch
"create-agent-bundle": patch
---

Generated route declarations exclude schema-less script routes, and `create-agent-bundle` requires coherent `agent-bundle` / `@agent-bundle/runtime` identities when scaffolding from local tarballs. (#168)
