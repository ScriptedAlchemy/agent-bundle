---
"agent-bundle": patch
---

Emit Cursor MCP configuration at the plugin root, keep the confirmed
`.cursor-plugin/plugin.json` local-plugin manifest with an explicit Cursor hook
document pointer, and document a physical copy installation because Cursor
rejects symlinks whose targets are outside `~/.cursor/plugins/local`. Validate
Cursor artifacts against the vendored official manifest schema and strict
MCP/hooks schemas, with real-host provenance for `${CURSOR_PLUGIN_ROOT}`.
