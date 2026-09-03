---
"agent-bundle": patch
"create-agent-bundle": patch
---

Omit schema-less script routes from the generated route declarations, and make `create-agent-bundle` refuse local-tarball scaffolds whose `agent-bundle` and `@agent-bundle/runtime` identities disagree. (#168)
