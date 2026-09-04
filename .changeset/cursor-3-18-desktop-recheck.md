---
"agent-bundle": patch
---

Re-date the Cursor capability table's desktop hooks evidence against Cursor 3.18.25: `sessionStart` is dispatched to plugin-scoped hooks on the desktop (the earlier 0× count was a 3.14.7 behaviour), and `subagentStart`/`subagentStop` delivery varies by instance on the same build — where an instance does not deliver them, `request.lineage` reports `id-not-resolvable` for the child rather than inferring a parent. Evidence notes only; no projection or `request.lineage` behaviour changes (#424)
