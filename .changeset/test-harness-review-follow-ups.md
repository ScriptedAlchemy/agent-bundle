---
"agent-bundle": patch
---

Bind route-unit test loaders to the manifest that produced them, so rendering
against an explicit manifest can no longer execute the registered project's
module for a colliding route id. `expectDocument().toHaveValue()` now separates
a document that emitted no value from one whose value is `null`, `renderRoute`
records request-scoped progress even when the caller supplies its own reporter,
and the generated registry's version is validated where the helpers read it
rather than only in `registerTestRoutes`.
