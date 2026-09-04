---
"agent-bundle": patch
---

Add optional `plugin.logo` so Cursor artifacts can emit a `logo` field.

The path is validated at build time (AB4012) and copied into the artifact; Cursor `.cursor-plugin/plugin.json` references it relatively. Claude and Codex manifests still have no icon field, so they omit it on purpose. Artifact validation fails with AB6025 when a declared logo is missing from the deploy tree.
