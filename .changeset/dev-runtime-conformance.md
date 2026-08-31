---
"agent-bundle": patch
---

Harden the Runtime App development relay against Rsbuild protocol changes.
Only the provider-emitted `full-reload` signal now reinstalls the opaque App
child; private `ok` and `hash` frames and unknown future frame kinds are
ignored. Runtime compiler WebSocket paths come from normalized Rsbuild
configuration, and bounded credentials are encoded without assuming an
undocumented token alphabet.
