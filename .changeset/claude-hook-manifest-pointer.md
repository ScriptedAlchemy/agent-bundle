---
"agent-bundle": patch
---

Point the unified `plugin` bundle's `.claude-plugin/plugin.json` `hooks` field at `./hooks/hooks.json` so Claude Code loads the Claude/Codex document instead of also discovering `hooks/hooks-cursor.json` and invoking Cursor wrappers that expect camelCase `hook_event_name` values (`preToolUse` / `postToolUse`).
