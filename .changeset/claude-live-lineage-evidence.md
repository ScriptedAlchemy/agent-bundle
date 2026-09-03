---
"agent-bundle": patch
---

Record live-model evidence (Claude Code 2.1.257, 2026-09-03) on the Claude capability table's `lineage.subagent-events`, `lineage.root`, `lineage.parent`, and `lineage.mcp-correlation` rows — the parent's `Agent` PostToolUse names the child in `tool_response.agentId`, `background_tasks[]` lists only background subagents, and `claudecode/toolUseId` correlates parallel MCP calls — and route `pnpm test:packed:native:claude` / `pnpm test:packed:native:codex` through `scripts/run-packed-native-smoke.mjs` so the opt-in packed native smokes pack and install with npm instead of failing under pnpm's `pack --json` and `install --omit=dev`. Emitted host output and `adapterRevision` are unchanged. (#436)
