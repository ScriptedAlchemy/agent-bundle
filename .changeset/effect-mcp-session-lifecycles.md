---
"agent-bundle": patch
---

Rewrite MCP session lifecycles on Effect: the open acquisition chain is scoped `acquireRelease` resources, session teardown is one structured Effect, and the #134 fail-closed stale-epoch contract rides the typed error channel. No public API or wire-contract change.
