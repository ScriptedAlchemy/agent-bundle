---
"@agent-bundle/runtime": minor
"agent-bundle": minor
---

Expose a recipient-scoped, read-only notice inbox through generated stateful
MCP servers. Inbox reads record bounded availability and observed re-read
evidence without acknowledging notices or marking delivery attempted; stateless
projects emit no inbox resource or related runtime imports.
