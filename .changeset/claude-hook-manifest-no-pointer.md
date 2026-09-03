---
"agent-bundle": patch
---

Stop emitting a `hooks` pointer in `.claude-plugin/plugin.json` for the `claude` and unified `plugin` targets: Claude Code loads `hooks/hooks.json` on its own and reports a manifest pointer at that same file as a duplicate hooks file (`hook-load-failed`, observed on Claude Code 2.1.259). The generated Claude wrappers keep comparing `hook_event_name` against the pinned PascalCase spellings (`PreToolUse`, `PostToolUse`, `Stop`, ... for every supported Claude event), now covered by a per-event regression test; `native hook_event_name must equal postToolUse` on a Claude session identifies a Cursor-built wrapper under the Claude plugin root. (#470)
