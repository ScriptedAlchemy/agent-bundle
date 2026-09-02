---
'agent-bundle': patch
---

Fix installed-host verification to reject integrity failures before spawning
an MCP command, distinguish simulated staging from real host-install proof,
and accept artifacts that declare no resources or hooks. Preserve caller-owned
progress handlers while the contract matrix observes lifecycle notifications.
