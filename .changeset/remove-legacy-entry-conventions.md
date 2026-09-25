---
"agent-bundle": minor
"create-agent-bundle": patch
---

Require every local stdio MCP entry to default-export a server factory: self-connecting entries no longer build and AB4730 is now an error instead of an informational nudge; retire AB4736, so documents left in the top-level `skills/`, `commands/`, and `rules/` locations are ignored rather than reported (#839)
