---
'agent-bundle': patch
---

Stream Flight bytes from generated MCP and event-route workers as they render instead of buffering the whole document: a `Suspense` fallback authored in a compiled tool or event route now reaches the stdio MCP client (`notifications/progress`), standalone hook wrappers, and the Workbench's production route surface before the suspended child resolves, and a consumer that stops reading releases the worker render instead of crashing the host on a late chunk. (#700)
