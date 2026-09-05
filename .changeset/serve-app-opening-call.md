---
"agent-bundle": patch
---

Fix `agent-bundle serve-app` (and `serveApp`) showing the "ordinary tool result" fallback with `AB8010: Request body exceeds 64 KiB` instead of the App when the opening tool's result is large, and give a served App one scrollbar instead of three nested ones (the host page, the MCP App sandbox document, and the Runtime App surface proxy no longer scroll around it). (#565)
