---
"agent-bundle": minor
---

Add host-scoped Claude Code plugin defaults under `claude.settings` and emit a validated plugin-root `settings.json` for Claude targets, pinned to the documented `agent` and `subagentStatusLine` keys. Declaring `agent` warns that the plugin agents component is still deferred, so the referenced agent must reach the plugin root another way.
