---
"agent-bundle": minor
---

Add `definePrebuilt` (exported from `agent-bundle` and `agent-bundle/config`) and the `runtimeDependencies` field on `payload` entries: a prebuilt payload declares the bare package names its files load at run time, since the compiler never opens a payload file. `agent-bundle validate` reports `AB4751` when an entry is not a bare package name or `package.json` does not declare it under `dependencies` or `optionalDependencies` (a malformed list is `AB4740`), and the prepack gate's `AB7014` now counts a declared runtime dependency as used. The normalized model carries `NormalizedPayload.runtimeDependencies`. (#619)
