---
"agent-bundle": patch
---

MCP sessions re-check the caller abort signal after the asynchronous epoch availability probe and before tool dispatch, so a request cancelled while the probe is pending no longer dispatches the tool. (#163)
