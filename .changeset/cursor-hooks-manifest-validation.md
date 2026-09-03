---
"agent-bundle": patch
---

Validate the Cursor hooks document that `.cursor-plugin/plugin.json` `hooks` names instead of always reading `hooks/hooks.json`, so `agent-bundle doctor` (`AB7319`/`AB7320`) and `validateCursorPlugin` (`AB6027`) no longer reject a unified `plugin` bundle whose Cursor manifest points at `hooks/hooks-cursor.json` beside the Claude-format `hooks/hooks.json`. A declared hooks file that is missing or leaves the plugin root is now an `AB6027` error, an inline `hooks` object is validated in place, and Doctor's `AB7322` registration proof applies the same folder-discovery fallback. (#439)
