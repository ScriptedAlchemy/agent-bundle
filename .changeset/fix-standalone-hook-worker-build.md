---
"agent-bundle": patch
---

Keep standalone event-hook worker URLs runtime-relative so generated wrappers
compile without Rspack attempting to bundle the separately emitted worker.
