---
"agent-bundle": patch
"@agent-bundle/runtime": patch
"create-agent-bundle": patch
---

Speed up `agent-bundle build` and the dev server by reading each route module once per build instead of once per surface, caching prepared statements in the `@agent-bundle/runtime/state/sqlite` driver, and bounding directory-walk concurrency; keep `node:*` imports out of the Workbench browser bundle by moving the MCP App consent-capability vocabulary to a browser-safe module. `create-agent-bundle` shares the same corrected helpers. (#348)
