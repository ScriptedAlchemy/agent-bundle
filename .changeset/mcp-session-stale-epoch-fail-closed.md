---
"agent-bundle": patch
---

Fail MCP playground tool calls closed when the session's pinned artifact
epoch is removed underneath it. A long-lived `agent-bundle dev` server whose
project changed substantially — edits plus `agent-bundle build` runs from
another process, whose epoch retention cannot observe this process's epoch
leases — could lose the epoch a live MCP session was bound to. Tool calls
then kept executing against a vanished artifact or pended without any
indication that the project had changed. `tools/call` now probes the epoch
store before dispatch and on failure: a vanished epoch raises a typed
`McpSessionStaleEpochError`, cancels every in-flight tool call with the same
typed failure, and closes the session, mirroring the stderr-overflow
fail-closed contract. The MCP session routes surface it as a fail-closed
`AB8018` (409) diagnostic — like the artifact routes' epoch mapping — so the
Workbench playground renders the failure in its existing invocation-error
state instead of hanging silently.
