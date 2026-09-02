---
"agent-bundle": minor
"@agent-bundle/runtime": patch
---

Execute conventional `src/providers/*.{ts,tsx}` factories once per generated
MCP or event request and mount their values at
`(await agent()).providers.<camelCaseKey>`. Provider execution is deterministic,
sequential, abort-aware, and fail-closed; duplicate, reserved, and invalid
provider exports report `AB4940`–`AB4942`.

Export `AgentRenderInvocation` as a type from the runtime package root so
provider authoring types do not require an internal import.
