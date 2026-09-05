---
"agent-bundle": patch
---

Make the `agent-bundle` CLI treat invalid `--port`, `--trials`, `dev --install-host`, and install or uninstall `<host>`, `--mode`, and `--scope` values as usage errors that exit with code 2. (#615)
