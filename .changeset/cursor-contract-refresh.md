---
"agent-bundle": patch
---

Add the `cursor.*` config extension so Cursor builds emit manifest metadata
(`author`, `homepage`, `repository`, `license`, `keywords`, `publisher`,
`category`, `tags`, `minClientVersions`) into `.cursor-plugin/plugin.json`;
invalid values are reported as `cursor.manifest.field.unknown`,
`cursor.manifest.author.*`, and `cursor.manifest.<field>.invalid` instead of a
generic schema failure. Cursor `subagentStart`/`subagentStop` hooks now
validate the documented envelope (every field except `git_branch` required),
decode `subagent_model` into `event.model`, and only return a
`followup_message` when the subagent `status` is `completed`; the `cursor` and
`plugin` capability reports list every documented Cursor hook event with its
cloud availability. (#375)
