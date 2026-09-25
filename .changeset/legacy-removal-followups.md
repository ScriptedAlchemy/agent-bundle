---
"agent-bundle": patch
"@agent-bundle/runtime": patch
---

Accept a CommonJS `module.exports` server factory as the default export of a
stdio MCP entry, so `AB4730` no longer rejects a `.cjs` entry the generated
lifecycle shell can run, and reject a SQLite state store at open with the
typed `corrupt` error when its journal schema differs in column nullability
from the one the current kernel writes. (#850)
