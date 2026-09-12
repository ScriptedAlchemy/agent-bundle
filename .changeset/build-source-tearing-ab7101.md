---
"agent-bundle": patch
---

Reject `agent-bundle build` and programmatic `build()` with `AB7101` when project source changes during compilation, so a one-shot artifact cannot publish compiler metadata from one source snapshot against bytes compiled from another.
