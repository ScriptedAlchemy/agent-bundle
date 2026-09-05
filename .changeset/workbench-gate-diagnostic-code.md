---
'agent-bundle': patch
---

Workbench connection gate and Overview rebuild alert: show the foreground diagnostic code and message — `AB8003 — Origin http://localhost:3000 is not allowed by the foreground server at http://127.0.0.1:3100. Open http://127.0.0.1:3100 instead, or start agent-bundle dev with --workbench-dev-origin http://localhost:3000 to allow this origin.` — with an `(HTTP <status>)` suffix only when the foreground response itself failed, instead of the misleading `Workbench request failed with HTTP 200.` (#589)
