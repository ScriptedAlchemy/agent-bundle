---
"agent-bundle": patch
---

Refresh the Cursor plugin contract against the public docs retrieved 2026-09-02
(#189). Validate the documented Cursor `subagentStart`/`subagentStop`
envelopes (every field except `git_branch` required) in event routes and
generated hook wrappers, project them only through `permission: "deny"` +
`user_message` and `followup_message`, and fail closed when a continuation is
requested for a subagent whose `status` is not `completed`. Add the `cursor.*`
config extension that emits schema-admitted manifest metadata (`author`,
`homepage`, `repository`, `license`, `keywords`, `publisher`, `category`,
`tags`, `minClientVersions`) into `.cursor-plugin/plugin.json`, validated with
the pinned schema's `uri`/`email` formats and reported as `cursor.manifest.*`
diagnostics (`cursor.manifest.field.unknown`, `cursor.manifest.author.*`,
`cursor.manifest.<field>.invalid`). Record every documented Cursor hook event
(21) with cloud availability, hook options, plugin formats, component
discovery, variables, marketplace limits, distribution and local-install
surfaces, canvases, and the agents component as dated capability rows, mirrored
through the unified `plugin` adapter. Cursor `adapterRevision` 1.8.0 → 1.9.0,
unified plugin 1.24.0 → 1.25.0. (#375)
