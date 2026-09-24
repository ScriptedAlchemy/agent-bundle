---
"agent-bundle": patch
---

Make `agent-bundle build` emit byte-identical artifacts from any checkout path and host platform: generated wrappers import project modules by project-relative POSIX specifiers, and the manifest `modelDigest` no longer hashes absolute route, handler, `web`, or `state` paths (#835).
