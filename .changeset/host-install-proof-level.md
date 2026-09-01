---
"agent-bundle": minor
---

Add the `host-install` consumer proof level for real public-path installation
into isolated Claude, Codex, and Cursor homes. The source-built proof fixture
exercises Skills, Hooks, and MCP registration without model calls or packed
artifact claims, validates Cursor's emitted documents against the pinned
schemas, and records only path-relative evidence.

Generated Claude and Codex installation instructions now use
`plugin marketplace add ./`; Claude Code 2.1.257 rejects the previously emitted
bare `.` source.
