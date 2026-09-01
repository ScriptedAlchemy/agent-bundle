---
"@agent-bundle/runtime": patch
---

Rewrite the state-kernel driver internals on Effect v4 behind the unchanged
public API: `Scope`/`Layer` own sqlite connection and BEGIN IMMEDIATE
transaction lifecycles (`acquireUseRelease` commit/rollback), and the kernel's
fail-closed states ride a typed `AgentStateError` error channel mapped back at
the boundary module. `defineState`/`dispatch`/`read`/`changes`/`reset` still
return the same Promise shapes and reject with the same typed errors; root and
plugin entries still ship zero kernel or effect bytes.
