---
"agent-bundle": minor
---

Derive project package identity from `package.json` (#94 Wave 1 stages 1–2).

Normalized models, artifact manifests, inspect results, and development
source status now expose validated `packageName`/`packageVersion`.
`plugin.version` still authors the native plugin version but no longer
silently wins: a mismatch warns (`AB4008`) and `package.json` remains
authoritative. `plugin.name` is unchanged (G9). Unpackaged or unversioned
projects receive the labeled `0.0.0-dev` development fallback.
