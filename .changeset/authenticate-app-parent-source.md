---
"agent-bundle": patch
---

Make `createAppClient()` authenticate unconfigured MCP App transports by exact parent source while preserving strict HTTP(S) `targetOrigin` pinning.
