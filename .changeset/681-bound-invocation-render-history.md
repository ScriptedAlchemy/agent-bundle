---
'agent-bundle': patch
---

Bound every retained copy of a Workbench route invocation's render stream under one render-history window — the newest 256 events and at most 2 MiB serialized, always keeping the newest event and the newest `shell`/`replace`/`complete` event — applied alike to the live `GET /api/routes/invocations/<id>/stream` replay, the completed and cancelled envelopes, `GET /api/routes/invocations/<id>`, the terminal `final` message, and the Workbench's live view. The render child no longer returns the whole event stream over IPC and the compiled-route producer keeps only the `complete` document. Envelopes whose events were evicted carry a new optional `retention` field (`producedEvents`, `evictedEvents`, `evictedBytes`, `retainedBytes`); `document`, `result`, `outcome`, and `correlationId` are never truncated. (#692)
