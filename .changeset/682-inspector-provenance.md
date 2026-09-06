---
"agent-bundle": patch
---

Make Workbench artifact provenance fail closed and read from one record: `ArtifactInspectionService` refuses an epoch (`AB6200`, `Artifact file has no manifest provenance record.`) instead of inspecting a `files[]` row with invented empty provenance when its `compiler.provenance` row is missing, and the Workbench Artifact file details render each file's source inputs from that file's own manifest record — a row with none reads `No source inputs recorded` — rather than a by-path lookup that defaulted to `—`. Adds inspector-level missing, conflicting, and relocated provenance tests (#719)
