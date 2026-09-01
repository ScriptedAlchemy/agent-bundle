---
"agent-bundle": patch
---

Rewrite the dev coordinator's coalescing rebuild scheduler on Effect: build passes run as fibers holding a `Semaphore(1)` permit, and coalesced follow-up rebuilds share one `Deferred` result. No public API or behavior change.
