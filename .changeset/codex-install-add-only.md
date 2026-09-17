---
"agent-bundle": patch
---

Replace Codex plugins with `codex plugin add` only so nested MCP overrides in `config.toml` survive. Refuse disabled or unknown-enablement Codex replacements (`AB7004`) because pinned Codex has no settings-preserving update API. (#824)
