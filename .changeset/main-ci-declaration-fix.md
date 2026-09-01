---
"agent-bundle": patch
---

Keep the optional `@agent-bundle/runtime` peer out of the dev server's emitted declarations: the Agent Document route now consumes the peer through an opaque structural loader, so consumers without the optional peer compile against the packed root types again.
