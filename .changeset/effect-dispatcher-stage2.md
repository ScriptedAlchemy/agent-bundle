---
"@agent-bundle/runtime": patch
---

Rewrite the runtime dispatcher internals on Effect v4 behind the unchanged
`dispatch()` / `stream()` Promise and ReadableStream edges. Flight decode is
an Effect Stream with native pull backpressure; invocation-local boundary
reconciliation and contract bounds are stream stages; host AbortSignal is
honored at the public edge via the boundary interruption bridges.
