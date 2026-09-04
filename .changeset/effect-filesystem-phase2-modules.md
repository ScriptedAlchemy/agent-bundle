---
"agent-bundle": patch
---

Internal: run the ordinary filesystem I/O of the plugin validators (`validate`, `AB60xx` portable / Claude / Cursor plugin diagnostics), the Codex native contract, `mcp list` / `mcp invoke` / `mcp run` / `hooks list`, the eval harnesses, and the post-build artifact readers (`validateArtifact`, pack inventory) through Effect's `FileSystem` service. Behavior, diagnostic codes, and error messages are unchanged; `mcp run` removes its SIGINT/SIGTERM forwarders through a scope finalizer, and the MCP client's per-connection plugin-data directory is a scoped temp directory. (#PR)
