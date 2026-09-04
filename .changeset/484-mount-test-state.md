---
'agent-bundle': patch
---

Export `mountTestState()` and `withTestState()` from `agent-bundle/test`: mount the project's state definition and notice ledger once — a disposable sqlite root for `workspace-durable`, the memory driver otherwise, or `options.driver` — and spread `context()` into any number of `renderRoute` / `renderRouteEvents` calls for a multi-render journey, with `read()` and `notices()` snapshots and one `close()`. `options.definition` mounts an explicit definition instead; a manifest without state or an `external` definition without a driver fails closed (`manifest-unavailable`, `invalid-input`). The worktree-proximity, host-test, and audiobook-curator examples drop their hand-rolled `@agent-bundle/runtime/mount` and `/state` mounts for it. Fixes #484. (#525)
