---
"@agent-bundle/runtime": minor
---

Add the versioned realm-singleton request store, `await agent()`, and
Observed identities (#95 Wave 1). MCP and CLI entrypoints install a closed
request lease so `execute` can read the same `AgentInvocation` (kind
`tool` | `event` | `cli` | `script` | `workbench`) without a daemon or
durable state. `state`, `notices`, and `providers` are reserved extension
slots; a captured handle throws after the request completes.
