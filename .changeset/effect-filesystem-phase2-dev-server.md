---
"agent-bundle": patch
---

Keep `agent-bundle dev` — the Workbench dev server, its host installs, MCP sessions and probes, hook / host-discovery / native / script playgrounds, skill documents, evals, and asset serving — behaving exactly as before while every service's file reads, temporary directories, and removals run on one platform runtime that `startDevServer` creates and the session's `close` releases after the last service has closed. Diagnostics, routes, and responses are unchanged. Two lifetimes are now explicit: an MCP session's plugin-data directory lives exactly as long as the session (removed when the session closes, or when an open fails before the session exists), and a script playground workspace that cannot be removed is still reported in the run result's `cleanupFailures` instead of replacing the script's outcome. `agent-bundle --version` / `--help` keep loading no Effect module. (#PR)
