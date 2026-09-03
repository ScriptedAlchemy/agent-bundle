---
"agent-bundle": patch
---

Extend the Claude host capability table (`claude-2.1.250.json`, rendered on the hosts reference page) with live Claude Code 2.1.259 evidence on the `lineage.subagent-events`, `lineage.root`, `lineage.parent`, `lineage.depth`, and `lineage.mcp-correlation` rows: two `Agent` spawns issued in one message bind to their own spawn calls, `Explore` subagents carry the same lineage fields as `general-purpose` ones, `PostToolUseFailure` carries the subagent's `agent_id`, the root `session_id` survives `--resume` and `/compact`, and `claudecode/toolUseId` correlates MCP calls at depth 0, 1, and 2. Emitted host output and `adapterRevision` are unchanged. (#455)
