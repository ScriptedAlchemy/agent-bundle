---
"agent-bundle": patch
---

Rewrite EpochStore staging, leases, and recovery orchestration on Effect: store and process-wide lease mutexes are `Semaphore(1)` permits, the publication saga carries Exit-aware compensations, and retention aggregates concurrent deletions via per-element `Exit`. No public API, on-disk format, or behavior change.
