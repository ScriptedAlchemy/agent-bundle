---
"agent-bundle": patch
---

Simplify prebuilt-payload internals (post-#71 follow-up): dev-server preparations no longer pay the AB4750 payload-freshness mtime walk for commands that discard it, the payload-declaration parse and innermost-payload ownership rule are shared across discovery, normalization, and validation instead of being open-coded per module, and `PreparedProject.snapshotSource` is required so artifact re-snapshots always observe the payload roots the prepared identity hashed.
