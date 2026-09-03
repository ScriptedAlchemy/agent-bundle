---
"agent-bundle": patch
---

Record the live Claude Code 2.1.259 orchestration session (2026-09-03) on the Claude capability table's `lineage.*` rows: two `Agent` spawns issued in one message arrive serialised so each child binds to its own spawn call, an `Explore` subagent carries the same lineage fields and reaches the plugin's MCP tools, `PostToolUseFailure` inside a subagent carries the subagent's `agent_id`, the root `session_id` survives `--resume` and a manual `/compact`, and `claudecode/toolUseId` matched at depth 0, 1, and 2 (fixtures `fixtures/host-lineage/claude-2.1.259-orchestration{,.stream}.ndjson`). Emitted host output and `adapterRevision` are unchanged.
