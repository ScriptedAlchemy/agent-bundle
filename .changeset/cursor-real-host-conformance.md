---
"agent-bundle": patch
---

Emit Cursor local-plugin manifests and MCP configuration at the artifact root,
select the Cursor hook document explicitly in unified bundles, and document a
physical copy installation because Cursor rejects symlinks whose targets are
outside `~/.cursor/plugins/local`. Pin the real-host loader evidence for local
layout and `${CURSOR_PLUGIN_ROOT}` substitution.
