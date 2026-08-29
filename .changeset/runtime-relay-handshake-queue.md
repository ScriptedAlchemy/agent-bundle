---
"agent-bundle": patch
---

Stop dropping host messages relayed to a Runtime App during its initialize
handshake. The dev-server client-surface relay forwarded host-to-app
traffic only once the App had reported `ui/notifications/initialized`
(plus the initialize response itself) and silently discarded anything
earlier, so a host request that raced the handshake — observed as
`ui/resource-teardown` on contended runners — could never be answered.
The relay now queues up to 32 validated host messages during the handshake
and flushes them once the App initializes; the queue survives an HMR entry
reload so a request sent to a retiring App instance is answered by its
replacement.
