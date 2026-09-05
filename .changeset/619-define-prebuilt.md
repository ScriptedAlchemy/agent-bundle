---
"agent-bundle": minor
---

Add `definePrebuilt` to `agent-bundle` and `agent-bundle/config`, with a
`runtimeDependencies` field for the bare package names a prebuilt payload
loads. Report a malformed list as `AB4740`, and as `AB4751` a name npm does
not read as a bare package name or one `package.json` does not install for a
consumer (`dependencies`, `optionalDependencies`, or a peer not marked
optional); count declared runtime dependencies as used for `AB7014` and expose
them as `NormalizedPayload.runtimeDependencies`. (#630)
