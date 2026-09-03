---
"agent-bundle": patch
---

Promote the `file/change`, `config/change`, `task/create`, `task/complete`, and `agent/idle` canonical event-route families as Claude-only capabilities with their documented decision channels: `config/change` and `task/create` project deny as a top-level block decision, `agent/idle` projects deny as `continue: false` with a stop reason, while `file/change` and `task/complete` are observation-only with fail-closed errors explaining the host's side-effect-only and exit-code-only control models. Codex, Cursor, and portable carry dated `unavailable` rows per family.
