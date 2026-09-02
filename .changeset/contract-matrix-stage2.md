---
"agent-bundle": minor
---

Add stage-2 stateful lifecycle replay to the generated-plugin contract matrix (#218). Projects can supply deterministic `unknown → queued → running → first-progress → repeated-progress → terminal` drivers while the shared matrix owns transport, per-phase schema/render/compat checks, live-progress evidence, journal accumulation, notice observation, idempotency replay, typed commit-budget rejection, and same-store restart durability at both in-memory and packed boundaries.
