---
"agent-bundle": patch
---

Route catalog and MCP prefill correctness fixes from post-merge review: CLI
usage summaries mark repeatable named options with the same ` ...` operand
suffix the generated help prints; optional booleans without a schema default
keep an unset state (a three-state omitted/true/false control) instead of
submitting an explicit `false` the handler can observe; and a stale
Routes-page prefill naming a tool the server no longer advertises surfaces a
missing-tool notice instead of silently attaching the prepared arguments to
the first advertised tool.
