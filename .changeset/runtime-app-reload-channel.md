---
"agent-bundle": minor
---

Carry Runtime App reloads over a provider-owned channel instead of Rsbuild's
private WebSocket protocol. The trusted client-surface endpoint now exposes
`subscribeReload`, fed by the provider's successful, changed App environment
compile hook; the relay proxy hosts its own one-way reload WebSocket at
`/__agent_bundle_runtime/reload`, replays the current reload generation on
every (re)connect, and refreshes the opaque App child only when that
generation strictly advances. The proxy no longer dials Rsbuild's WebSocket,
so the endpoint's `webSocketOrigin`/`webSocketPath`/`webSocketToken` fields
and the Runtime App preview's `clientSurface.webSocketPath` field are gone,
and no Rsbuild HMR credential is handled outside the compiler process.
