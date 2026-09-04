---
"agent-bundle": patch
---

Fix `agent-bundle serve-app` (and `serveApp`) dropping the App to the "ordinary tool result" fallback with `AB8010: Request body exceeds 64 KiB` when the opening tool's result is large: the host page now binds the tool call the host already made by tool name instead of re-sending the result through `POST /api/mcp/sessions/<id>/apps`. `McpAppRoutes` accepts an `openingCall` for that purpose; the Workbench's full-body shape is unchanged. (#565, fixes #562)
