---
"@agent-bundle/runtime": patch
---

Interrupt `projectMcpRenderStream` promptly when its `signal` was already aborted between composition and start: the Effect boundary bridge re-checks `signal.aborted` after subscribing, so a pre-aborted projection rejects instead of hanging. (#164)
