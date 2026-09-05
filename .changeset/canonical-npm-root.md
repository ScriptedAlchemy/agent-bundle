---
"agent-bundle": minor
---

Package the validated composite root as the npm root, remove the obsolete package installer wrapper, point generated CLI bins at the manifest-declared executable so every command including `web` has artifact parity, and report `AB4767` when no selected target emitted that executable (#639).
