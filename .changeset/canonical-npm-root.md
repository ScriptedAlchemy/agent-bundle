---
"agent-bundle": minor
"create-agent-bundle": minor
---

Package the validated composite root as the npm root, point generated CLI bins at its manifest-declared executable, advance `agent-bundle.manifest.json` to version 3, preserve supported lifecycle assets and authored `AGENTS.md`, persist package-only compile evidence, reject unpublishable dependency protocols with `AB7015`, and report missing generated executables or lifecycle assets with `AB4767` and `AB4768`; rebuild and replace version 2 installs before managing them with this release (#656).
