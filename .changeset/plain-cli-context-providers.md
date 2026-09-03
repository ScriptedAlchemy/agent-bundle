---
"agent-bundle": patch
---

Mount conventional request context providers for plain `.ts` routed CLI commands, so `(await agent()).providers` carries the same values on every generated request scope (MCP, events, rendered CLI, rendered scripts, and now plain CLI) with identical ordering, cancellation, and fail-closed semantics; the plain execute context also exposes the consumed `args`. The rendered-session bridge now forwards the invocation to its react-server worker, so providers behind rendered CLI commands and rendered scripts observe the real `invocation.kind` instead of `undefined`.
