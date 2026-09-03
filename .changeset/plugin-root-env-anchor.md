---
"agent-bundle": patch
---

Anchor every emitted stdio MCP server entry with a well-known
`AGENT_BUNDLE_PLUGIN_ROOT` environment variable holding the plugin install
root in each target's native spelling: `${CLAUDE_PLUGIN_ROOT}` on Claude Code,
`${PLUGIN_ROOT}` on portable, `${CURSOR_PLUGIN_ROOT}` on Cursor, and `./` on
Codex resolved against the entry's plugin-root cwd (a Codex entry without one
omits the anchor; source-built servers always carry it on every target).
User-declared `env` keys win over the injected value. The Claude adapter also
stops dropping `cwd` for source-built servers and emits
`cwd: "${CLAUDE_PLUGIN_ROOT}"` as documented, schema-valid future-proofing —
Claude Code currently ignores the field at runtime, which is exactly why
runtime code should resolve persistent state against the env anchor instead of
the process working directory. The anchor name ships as the new
`pluginRootEnvAnchor` export, and every adapter's revision advances to 1.1.0
so previously built artifacts revalidate as stale instead of silently passing
with the old emission shape.
