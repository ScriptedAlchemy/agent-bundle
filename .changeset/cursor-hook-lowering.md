---
"agent-bundle": patch
---

Lower hooks to Cursor. The `cursor` target now emits the flat versioned
`hooks/hooks.json` with per-hook wrappers speaking Cursor's own stdin/stdout
envelope (pinned from the published hooks reference and verified against
installed Cursor plugins), and the unified `plugin` bundle ships dedicated
`hooks/<name>.cursor.mjs` wrapper variants beside the shared Claude/Codex
wrappers, replacing the empty schema-collision guard whenever a hook lowers
to Cursor. One authored hook now serves Claude Code, Codex, and Cursor.
