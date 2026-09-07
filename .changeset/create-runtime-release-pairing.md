---
"create-agent-bundle": patch
---

Make `npm create agent-bundle` select the compiler/runtime pair recorded by `create-agent-bundle`, preserve same-SHA previews, and reject incompatible `--framework-version` pairings before writing files. (#739)
