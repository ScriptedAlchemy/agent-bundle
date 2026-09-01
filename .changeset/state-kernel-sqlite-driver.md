---
"@agent-bundle/runtime": minor
---

Ship the workspace-durable state driver on `node:sqlite` (#98 v1, G3)
behind the dedicated `./state/sqlite` subpath: WAL journal mode with full
synchronous durability, every commit in one immediate transaction
(idempotency lookup, compare-and-swap, reducer, journal append, head update
commit atomically), cross-process writers serialized on the database lock
with a bounded busy timeout, explicit migrations on open, and corruption
failing closed with typed errors. The driver passes the same conformance
suite as the in-memory driver, plus cross-process proofs: two independent
processes updating one store, and a SIGKILLed writer never leaving a
successful-but-corrupt state. The subpath split keeps `node:sqlite` (and
its ExperimentalWarning) away from volatile-state and stateless consumers,
and the package now declares `"sideEffects": false` so bundlers can
tree-shake unused kernel exports.
