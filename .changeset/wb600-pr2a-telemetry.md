---
"agent-bundle": patch
---

Stop fabricating route-invocation provider and timing rows. Unmeasured providers now use status `unobserved` with no `durationMs`; `handler`, `providers`, and `provider:<name>` timings appear only when the child observed them. Failures record a measured `elapsed` phase instead of invented `failed` providers or a fake `render`. (#600)
