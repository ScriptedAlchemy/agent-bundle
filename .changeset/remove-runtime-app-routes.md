---
"agent-bundle": minor
---

Remove the Workbench runtime App preview path. The dev server no longer serves `/api/runtime/apps/**` or `/api/runtime/mcp/sessions/**`, `DevServerSession` (from `agent-bundle` and `agent-bundle/api`) drops `openRuntimeClientSurface`, and `DevRuntimeEventInput` no longer accepts `runtime.app.updated`, `runtime.hmr.client-connected`, or `runtime.hmr.client-disconnected`. The `AB8022` 410 and `AB8023` 413 runtime App responses are gone; both codes keep their other meanings. Runtime runs, status, surfaces, and MCP App previews for artifact sessions are unchanged. (#852)
