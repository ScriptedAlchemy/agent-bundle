---
"agent-bundle": patch
---

Keep `agent-bundle dev` and `agent-bundle eval` error output unchanged while their internal framework errors become yieldable Effect errors: every error message, `code`, `name`, `instanceof` check, JSON / `stableJson` serialization, and CLI stack trace is byte-for-byte what it was; emitted hook wrappers, `bin/*.mjs`, MCP shells, and `install.mjs` do not change in size or content; and no `effect` type enters any public `.d.ts`, so consumers still compile against `agent-bundle`, `agent-bundle/api`, `agent-bundle/eval`, and the other entries without an `effect` dependency. (#543)
