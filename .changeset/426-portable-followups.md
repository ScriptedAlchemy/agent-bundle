---
'agent-bundle': patch
---

Refresh the `portable` (Agent Plugins 1.0.0) capability table and schema provenance with the 2026-09-03 re-verification: the Cursor 3.18.25 `${PLUGIN_ROOT}` gaps in `cwd`, `args`, and the default working directory reproduce on the current build, and the `mcp` evidence now also records that `env` values are not expanded, the reserved `PLUGIN_ROOT`/`PLUGIN_DATA` variables are not provided, and plugin-relative `./` commands resolve against the workspace; the pinned 1.0.0 schemas were rehashed against the live specification site with no published 1.1.0 release, so the pin and `adapterRevision` are unchanged and the `AB6038` provenance info emitted by `validate` for portable artifacts now reads "re-verified 2026-09-03" (#443).
