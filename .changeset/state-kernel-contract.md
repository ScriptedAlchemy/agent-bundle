---
"@agent-bundle/runtime": minor
---

Add the optional Agent state kernel contract (#98 v1) behind the new
`./state` subpath: `defineState({ schema, initial, events, reduce })` with
the explicit lifetime taxonomy (`request` | `process` | `workspace-durable`
| `external`), typed `AgentStateError` codes, monotonic revisions,
exact-revision reads, idempotency-key replay/conflict, compare-and-swap,
explicit versioned migrations, and polling change cursors. Ships the
volatile in-memory driver (request/process lifetimes; never durable), the
request-bound handle that fills the reserved `state` slot on
`AgentRequestContext`, and the driver conformance suite every driver —
including external ones — must pass. Stateless projects import none of it.
