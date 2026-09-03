---
"agent-bundle": patch
---

Stop dispatching an MCP tool call whose request was cancelled while the epoch availability probe was pending: the dev-server MCP session re-checks the caller abort signal after the probe and before dispatch. (#163)
