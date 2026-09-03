---
"agent-bundle": patch
"@agent-bundle/runtime": patch
---

Remove nineteen unreferenced modules left behind by extractions that never
rewired their callers, collapse the surviving duplicated helpers onto their
canonical owners, and fix the three defects that drift had caused: the
Workbench Logs view now shows `lifecycle.replay.started`, `.completed`, and
`.failed` Dev Log records and records carrying `routeId` (the browser log
client's private copy of the `agent-bundle/contracts/dev-logs` vocabulary had
omitted them); the Workbench now subscribes to `dev.host.sync` project events,
which `project-client` had left out of its SSE listener list; and the
Playground trace store redacts with the shared `core/credentials` classifier,
which adds the provider environment-variable patterns its local copy lacked.
`@agent-bundle/runtime` drops the internal, never-exported
`expectCanonicalPayload` helper from `state/contract`. No public export, route,
diagnostic code, or runtime behavior changes otherwise. (#451)
