---
"@agent-bundle/runtime": patch
---

Record the dated deferral of task-augmented MCP tool calls (`CreateTaskResult`,
`tasks/get`, `tasks/result`, `tasks/cancel`): the installed MCP SDK ships only
the `2025-11-25` task wire vocabulary with no task runtime, and the
`2026-07-28` revision moves tasks into an extension. Generated servers stay
fail-closed — no `tasks` capability is advertised and task-augmented requests
are processed as ordinary calls — and a sentinel test pins the audited SDK
version so the deferral cannot go stale silently.
