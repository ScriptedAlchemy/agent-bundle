---
"agent-bundle": patch
---

Refuse a foreign destination and a same-version marketplace restage from `install.mjs` when the destination lacks paths listed in `agent-bundle.manifest.json`, instead of crashing with `ENOENT`. `uninstall --force` on a pre-receipt copy removes the files present in that copy, matching the framework CLI. (#812)
