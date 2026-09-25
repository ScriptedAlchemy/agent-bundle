---
"agent-bundle": patch
---

Refuse a foreign destination and a same-version marketplace restage from `install.mjs` when the destination lacks paths listed in `agent-bundle.manifest.json`, instead of crashing with `ENOENT`. (#818)
