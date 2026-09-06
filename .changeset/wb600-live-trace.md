---
'agent-bundle': minor
---

Add the Workbench Trace page and live development tracing through `/api/trace`, `/api/trace/stream`, and `/api/trace/receipts`; stream route runs with `POST /api/routes/invocations` using `stream: true` and `GET /api/routes/invocations/<id>/stream`, cancel them with `POST /api/routes/invocations/<id>/cancel`, and report cancelled runs with `status: 'cancelled'`. `route.invocation` project events now also fire when an invocation starts, with a running record (no `completedAt`/`outcome`); narrow on `status` before reading completion fields. `createEventTracer` called without `observer` now reads the process-local observer on every emission (and `enabled` reflects it live) instead of being permanently disabled, so a tracer created before `installEventTraceObserver` starts emitting once one is installed. Add diagnostics `AB8240`–`AB8243`, `AB8247`–`AB8249`, and `AB8256`. (#666)
