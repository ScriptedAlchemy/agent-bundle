---
"agent-bundle": patch
---

Keep timed-out MCP probes responsive when transport teardown stalls, while
continuing the transport close path that terminates stdio children. Redact
absolute paths that follow common key-value and list separators.
