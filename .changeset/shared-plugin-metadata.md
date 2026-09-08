---
"agent-bundle": patch
---

Declare shared plugin metadata once instead of once per host block. `author`, `homepage`,
`keywords`, `license`, and `repository` now default to the same field in the project's
`package.json`, `plugin.metadata` overrides them for every host at once, and a host block
(`portable`, `cursor`, `codex`, `claude.marketplace.plugin`) still wins for its own artifact.
`null` is a deliberate absence: in `plugin.metadata` it shares nothing, and in one host block it
keeps a shared value out of that one manifest. Each host emits only what its pinned schema
admits and validates it exactly as before. `AB4014` reports a malformed `plugin.metadata` field;
`AB4015` warns that a `package.json` field cannot be shared — an unconvertible `repository`
shorthand or SSH URL, say — and withholds it rather than guessing a web URL. `codex.author: null`
no longer reports `codex.manifest.author.invalid`; like the other four fields and the other hosts,
it now opts the manifest out. (#761)
