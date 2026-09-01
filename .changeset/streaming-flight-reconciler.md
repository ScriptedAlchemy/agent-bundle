---
"@agent-bundle/runtime": minor
---

Add incremental Flight decoding and an invocation-local Suspense reconciler.
`dispatcher.stream()` emits bounded `shell | progress | replace | error | complete`
events with stable-within-invocation boundary IDs, real backpressure, and
AbortSignal cancellation; `dispatcher.dispatch()` remains the default final-only
public API so existing generated entries keep working.
