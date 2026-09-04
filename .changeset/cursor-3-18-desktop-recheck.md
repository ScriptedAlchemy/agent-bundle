---
"agent-bundle": patch
---

Re-date the Cursor capability table's desktop hooks evidence against Cursor 3.18.25: `sessionStart` is dispatched to plugin-scoped hooks for newly created root chats — not for resumed roots or `Task` children — and the earlier 0× count came from 3.14.7 launches only; `subagentStart`/`subagentStop` delivery varies by instance on the same build, and where an instance does not deliver them `request.lineage` reports `id-not-resolvable` for the child rather than inferring a parent. Evidence notes only; no projection or `request.lineage` behaviour changes (#546)
