---
"agent-bundle": patch
---

Record the Codex MCP `${PLUGIN_ROOT}` lowering rule as a dated
`mcp.pathTokenLowering` row in the pinned `codex-0.147.0.json` capability
table (no host interpolation; a *leading* `${PLUGIN_ROOT}` in `command`,
`args`, `env` values, and `cwd` is rewritten to a `./`-relative path under
`cwd: "./"` only when `cwd` is the plugin root; embedded tokens,
`${PLUGIN_DATA}`, and workspace-root tokens fail the build), so the generated
hosts reference renders it from the table instead of a hardcoded note. The
`codex` target's `adapterRevision` advances to `1.12.0`, so previously built
Codex artifacts revalidate as stale against the changed table. (#PR)
