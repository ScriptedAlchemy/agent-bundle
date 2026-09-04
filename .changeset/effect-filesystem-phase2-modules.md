---
"agent-bundle": patch
---

Keep `agent-bundle validate` (the `AB60xx` portable / Claude / Cursor plugin diagnostics), `mcp list` / `mcp invoke` / `mcp run`, `hooks list`, `eval`, and the post-build artifact readers (`validateArtifact`, the pack inventory) behaving exactly as before while their file reads, copies, and temporary directories move onto the shared platform layer: the same diagnostic codes and messages, the same `ENOENT` / `ENOTDIR` / `ELOOP` errors at the same places, byte-identical built artifacts. Two guarantees are now unconditional: `mcp run` stops forwarding SIGINT/SIGTERM to the server the moment the server exits, however it exits, and `mcp invoke` removes its per-connection plugin-data directory even when connecting fails. (#540)
