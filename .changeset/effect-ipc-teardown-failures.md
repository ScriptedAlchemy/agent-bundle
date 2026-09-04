---
"agent-bundle": patch
---

Report shared event runtime teardown failures instead of swallowing them: `createEventRuntimeServer(...).close()` now rejects with `EventRuntimeTransportError` (`code: 'runtime-failed'`, "Unable to remove the event runtime endpoint.") when the owned socket path cannot be removed, and opening a server fails with the same error class ("Unable to release the event runtime endpoint claim.") — after shutting the just-started listener down — when the endpoint claim lock cannot be released. Successful opens and closes are unchanged, and the generated MCP runtime's shutdown surfaces the close error the way it already surfaces other teardown failures.
