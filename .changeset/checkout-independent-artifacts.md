---
"agent-bundle": patch
---

Make `agent-bundle build` emit byte-identical artifacts when one source is built from different checkout paths: generated wrappers import project modules by project-relative POSIX specifiers, and the manifest `modelDigest` hashes route, handler, `web`, and `state` paths relative to the project root. The `NormalizedPlugin` model returned by `validate`, `inspect`, and `build` now carries `projectRoot` (#835).
