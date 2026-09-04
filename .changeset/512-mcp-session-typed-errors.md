---
"agent-bundle": patch
---

Reject closed, uninitialized, or misused `agent-bundle dev` MCP sessions with a coded `McpSessionError` (`code` one of `session-closed`, `not-initialized`, `invalid-request-id`, `duplicate-request-id`, `invalid-server-name`, `service-closed`) instead of a bare `Error`; every message is unchanged, so existing message matches keep working. A tool call's request slot is now released — and its in-flight SDK request aborted — whenever the call is interrupted, not only when it settles. (#512)
