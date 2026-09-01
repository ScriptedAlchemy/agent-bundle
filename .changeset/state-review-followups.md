---
"@agent-bundle/runtime": patch
---

State kernel review follow-ups from #142/#149. Both drivers now consult the
idempotency key before running the reducer, so a committed key replays its
stored result even when the reducer would fail against the current head; the
committed result is stored per key (event journal rows now persist their
post-commit state) and rides the migration chain, so replay survives schema
migrations instead of failing `revision-unavailable`. The sqlite driver
verifies storage on open — journal continuity (a hand-deleted intermediate
row fails closed) and the materialized head against journal replay (a
schema-valid but hand-edited head fails closed) — and derives database file
names from a sha-256 hash of the complete definition id, so ids that share a
sanitized prefix no longer collide onto one file. Sparse arrays are rejected
at the JSON boundary instead of silently canonicalizing like dense ones. The
shared conformance suite pins the corrected semantics for every driver.
