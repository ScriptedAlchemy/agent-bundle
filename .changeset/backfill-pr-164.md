---
"agent-bundle": patch
"@agent-bundle/runtime": patch
---

Close an abort race in the Effect boundary bridges of both packages: `interruptWhenAborted` now re-checks `signal.aborted` after subscribing, so a signal aborted between composition and start interrupts the effect instead of hanging. (#164)
