---
'agent-bundle': patch
---

Bound route-invocation render history end to end: the render child, the `GET /api/routes/invocations/<id>/stream` replay, and the completed `RouteInvocation` envelope (`events`, as returned by `POST /api/routes/invocations` and `GET /api/routes/invocations/<id>`) each keep only the newest 256 render events, evicting oldest-first while preserving the final `complete` event, `document`, `outcome`, and correlation identifiers. (#PR)
