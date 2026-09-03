---
"agent-bundle": patch
---

Docs-only corrections from the closed-issue audit (#23, #45, #47, #63). The
published README no longer claims the Claude adapter emits
`cwd: "${CLAUDE_PLUGIN_ROOT}"` for source-built stdio servers — that emission
was deliberately removed because Claude Code's placeholder table excludes
`cwd`; the absolute entry path plus the `AGENT_BUNDLE_PLUGIN_ROOT` env anchor
carry the working-directory guarantee. No runtime code or export surface
changes.
