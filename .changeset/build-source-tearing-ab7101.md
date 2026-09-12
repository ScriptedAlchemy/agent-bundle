---
"agent-bundle": patch
---

Reject `agent-bundle build` and programmatic `build()` with `AB7101` when project source changes during compilation, after validation and before `publishArtifact` replaces live artifact or package output, so a torn compile cannot publish mixed snapshots. (#786)
