---
"agent-bundle": patch
---

Export `createAppClient` from `agent-bundle/app` with generated `AppRegister` route contracts, make `createMcpAppBridge` validate bound route ids, cancel App-owned requests, and reject duplicate request ids, and reword `AB4837` to name Apps as the bundle-safe exception. (#601)
