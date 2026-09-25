---
"agent-bundle": minor
---

Make `agent-bundle build` emit byte-identical artifacts from any checkout path: generated wrappers import project modules by project-relative POSIX specifiers, and the manifest `modelDigest` hashes route, handler, `web`, and `state` paths relative to the project root. The exported `NormalizedPlugin` type now requires `projectRoot`; hand-constructed models passed to `build()` must set it (#835).
