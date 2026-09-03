---
"agent-bundle": patch
---

Promote canonical `session/end` and `prompt/submit` event-route families across
Claude Code, Codex, Cursor, and composite plugin artifacts. Keep both families
route-only, validate their native envelopes, and fail closed when a rendered
result requests a host output channel that the pinned contract cannot express.
