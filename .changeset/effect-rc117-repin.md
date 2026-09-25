---
'agent-bundle': patch
'@agent-bundle/runtime': patch
'create-agent-bundle': patch
---

Update the bundled Effect runtime to `effect@4.0.0-rc.117` (with `@effect/platform-node-shared` and `@effect/platform-node` on the same RC). Consumer installs of `agent-bundle` and `@agent-bundle/runtime` no longer pull in `msgpackr`, `msgpackr-extract`, or `fast-check` through `effect`. (#832)
