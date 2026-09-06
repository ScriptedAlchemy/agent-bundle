---
"agent-bundle": patch
---

Record third-party clients of the emitted Agent Plugins artifact in the pinned portable capability table (`clients`), with the paths each client reads, the manifests that shadow them, its verbatim install commands, and a dated row per surface it does and does not load. `INSTALL.md` names, per client, only the discovery paths the built bundle actually carries, and the generated host reference renders the same records through the same validator instead of an unsourced list of native clients. A record fails the build when it claims a tier its own rows and paths do not support, marks a surface degraded or supported without dated evidence, names an artifact path with no evidence that it is read, or declares an install block with no command. (#721)
