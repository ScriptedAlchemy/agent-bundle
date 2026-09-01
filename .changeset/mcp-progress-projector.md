---
"@agent-bundle/runtime": minor
"agent-bundle": patch
---

Add the standards-compatible MCP progress/final projector and warm-runtime
fail-closed host. Generated tool calls emit `notifications/progress` only when
the caller supplied a token, return one `CallToolResult`, and refuse silent
rich-content drops, epoch mismatch, and a missing or restarted runtime.
