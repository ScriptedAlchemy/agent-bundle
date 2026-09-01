---
"agent-bundle": minor
---

Add the Workbench Agent Document stage (#105 stage 2). The dev server gains a
read-only `GET /api/runtime/runs/:id/document` route that decodes a succeeded
run's stored Flight through the optional `@agent-bundle/runtime` peer's
bounded render-event decoder — Flight bytes never reach the browser — with
honest diagnostics when the peer is absent (AB8207) or the payload is not an
Agent Document (AB8208). The Workbench decodes the event stream with its own
strict schemas and renders it in a shared stage: Markdown through the audited
shared projector, text/context/json/progress/image/audio/resource/error
nodes, accumulated render diagnostics, live progress, final status, and an
inspectable event timeline, surfaced as a new Document view in the Runtime
Playground inspector. MCP protocol results deliberately keep showing the
lowered projection the server actually returned.
