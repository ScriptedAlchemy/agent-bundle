---
'agent-bundle': patch
---

Bound route-invocation render history end to end with one policy (`RENDER_EVENT_RETENTION`, exported from `contracts/invocations`): the render child, its IPC reply, the `GET /api/routes/invocations/<id>/stream` replay, the completed `RouteInvocation` envelope returned by `POST /api/routes/invocations` and `GET /api/routes/invocations/<id>`, and the Workbench live buffer each keep the newest 256 render events totalling at most 1 MiB of JSON, evicting oldest-first while the newest event, `document`, `result`, `outcome`, and correlation identifiers always survive. Envelopes that lost events carry `evictedEvents`; a cancelled run keeps the newest document a render event carried; stream replays are paced by socket drain instead of the live-consumer queue, so a reconnect whose window outgrows that queue no longer disconnects. (#699)
