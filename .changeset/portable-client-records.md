---
"agent-bundle": patch
---

Record third-party clients of the emitted Agent Plugins artifact in the pinned portable capability table (`clients`), with the paths each client reads, the manifests that shadow them, its verbatim install commands, and a dated row per surface it does and does not load. `INSTALL.md` and the generated host reference now print those records instead of an unsourced list of native clients, and a record that claims a tier its own rows do not support fails the build. (#721)
