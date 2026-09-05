---
"agent-bundle": minor
---

Add `definePrebuilt` to `agent-bundle` and `agent-bundle/config`, with a
`runtimeDependencies` field for the bare package names a prebuilt payload
loads. Report malformed lists as `AB4740` and invalid or undeclared names as
`AB4751`; count declared runtime dependencies as used for `AB7014` and expose
them through `NormalizedPayload.runtimeDependencies`. (#630)
