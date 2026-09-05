---
"agent-bundle": patch
---

Keep a generated MCP server running when another process from the same install already owns the event runtime socket: the server stands by and takes the socket over when the owner exits, instead of exiting with `Event runtime endpoint already has a live server`. `createEventRuntimeServer` gains `whenOwned: 'fail' | 'standby'` (default `'fail'`), and the returned server exposes `role()` and `onRoleChange()`; the standby start and the takeover are announced on stderr only (#561)
