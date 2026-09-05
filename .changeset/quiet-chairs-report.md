---
"agent-bundle": patch
---

Move invalid `--port`, `--trials`, `dev --install-host`, and install or uninstall `<host>`, `--mode`, and `--scope` values in the `agent-bundle` CLI away from `AB5000` diagnostics and exit code 1 to Commander usage errors and exit code 2. (#615)
