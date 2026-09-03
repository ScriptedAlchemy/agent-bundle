---
"agent-bundle": patch
"@agent-bundle/runtime": patch
"create-agent-bundle": patch
---

Consolidate duplicated guards and helpers onto canonical modules, with hot-path fixes riding along: route-graph module text is read once per build instead of once per surface, the sqlite state driver caches prepared statements, directory walks run with bounded concurrency, and the MCP App consent-capability vocabulary now lives in a browser-safe module so the Workbench bundle no longer pulls in `node:*` imports. (#348)
