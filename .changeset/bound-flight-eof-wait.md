---
"@agent-bundle/runtime": patch
---

Bound the Flight EOF wait by the render deadline and cancel stalled Flight
sources when the elapsed-time limit is exceeded.
