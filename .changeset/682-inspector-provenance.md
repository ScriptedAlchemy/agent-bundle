---
"agent-bundle": patch
---

Make Workbench Artifact file details render each file's own `compiler.provenance` source inputs and show `No source inputs recorded` for an empty record. Add an internal `AB6200` missing-row guard without remapping malformed on-disk manifests, which continue to fail parsing as `AB6001`. (#719)
