---
"@agent-bundle/runtime": patch
---

Add the #99 stage-4 delivery substrate to the notice ledger: recipient-scoped explicit `acknowledge()` (new `acknowledged` state, the strongest evidenced outcome), optional `retryBudget`/`nextAttemptAt` publish fields with re-attempt semantics evaluated only on admitted events (never an implied timer), a `signalAvailability()` ledger verb recording wire-level `resources/updated` signals as availability receipts (never delivery), and the pure delivery-route selector over per-host advertisements with a typed unavailable outcome. `delivered` remains deliberately absent from the state union because no pinned host supplies cross-actor delivery evidence (2026-09-02 survey on #99); pre-existing durable notices replay unchanged because the new fields are optional and never materialized by parse.
