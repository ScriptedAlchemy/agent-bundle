---
"agent-bundle": minor
---

Refresh the Cursor plugin contract against the public docs retrieved 2026-09-02
(#189). Cursor `subagentStart`/`subagentStop` now validate their documented
`subagent_*` envelopes and project through their real output channels
(`permission: "deny"` + `user_message`; `followup_message`), with wrapper,
playground, and lifecycle-replay fixtures. A new `cursor.*` config extension
emits schema-admitted manifest metadata (`author`, `homepage`, `repository`,
`license`, `keywords`, `publisher`, `category`, `tags`, `minClientVersions`)
into `.cursor-plugin/plugin.json` with `cursor.manifest.*` diagnostics. The
Cursor capability table records every documented hook event (21) with cloud
availability, hook options (`failClosed`, `loop_limit`, prompt hooks), plugin
formats, component discovery, variables, marketplace manifest limits, team
distribution and local-install surfaces, canvases, and the G5-gated agents
component as dated `supported`/`unavailable` rows; the unified bundle mirrors
each row and now intersects Cursor manifest metadata for real. Cursor
`adapterRevision` 1.8.0 → 1.9.0, unified plugin 1.22.0 → 1.23.0.
