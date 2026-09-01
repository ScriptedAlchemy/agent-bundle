---
"agent-bundle": patch
---

Fix inspect so commands and rules emitted by the composite plugin target are no longer reported as skipped for unsupported capabilities by accounting for component kinds as a union of host-side emission while preserving honest intersected capability claims.
