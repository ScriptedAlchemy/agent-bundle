---
"agent-bundle": patch
---

Fail closed when `compileRouteGraph` cannot read a discovered route module: only a racing `ENOENT` stays silent, so `inspect` and `validate` no longer treat permission or I/O failures as a vanished file.
