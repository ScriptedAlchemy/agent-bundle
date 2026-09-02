---
"agent-bundle": patch
---

Add user-initiated, read-only live MCP probing to the Workbench Hosts page
with per-probe consent, redacted launch details, honest neutral down states,
and ephemeral results. Discovery now enumerates installed-bundle MCP servers,
and the authenticated `POST /api/discovery/probes` route reports probe outcomes
with diagnostics AB8219 through AB8223.
