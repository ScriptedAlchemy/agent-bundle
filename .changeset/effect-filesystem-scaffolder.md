---
"create-agent-bundle": patch
---

Scaffold through Effect's `FileSystem` and `Path` services (`@effect/platform-node`): every filesystem failure during `create-agent-bundle` now surfaces once, at the CLI boundary, with the same Node error text and exit codes as before; the published tarball grows from 33 kB to 110 kB. (#501)
