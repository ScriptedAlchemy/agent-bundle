---
"agent-bundle": patch
---

Preserve Codex plugin settings across `agent-bundle install codex` replace: refresh with `codex plugin add` only so nested MCP overrides in `config.toml` survive, and restore a plugin-level `enabled = false` after native add resets it.
