---
"agent-bundle": patch
"@agent-bundle/runtime": patch
---

Drop the unused `open` dependency from `agent-bundle` and remove internal helpers that no package entry point exported and no code reached (the MCP App sandbox bridge, `durable-fs` pinned-file readers, unused Effect boundary helpers, `boundRenderEventStream`). Installs get one fewer package; no exported API changes. (#654)
