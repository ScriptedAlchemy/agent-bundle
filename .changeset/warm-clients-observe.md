---
'agent-bundle': patch
---

Generated MCP tool, resource, and prompt request scopes now observe native client, session, and authenticated actor identity alongside a derived process workspace, then forward those axes into the Flight worker while preserving typed unavailability when a transport omits them.
