---
"agent-bundle": patch
---

Make `agent-bundle validate --artifact` run Claude Code's validator against `.claude-plugin/plugin.json` and, when the bundle emits one, `.claude-plugin/marketplace.json`, instead of the bundle directory: Claude Code treats a directory holding both manifests as a marketplace and never opens `hooks/hooks.json`, `skills/`, `agents/`, or `commands/`, so hook, skill, and agent findings were invisible to the `claude` and `plugin` targets. On Claude Code 2.1.259 or later the runs use `claude plugin validate --json`, and every `AB6020` warning and `AB6021` error now names the validated file (`generatedPath`) and Claude Code's field path; older releases fall back to the text report with the same attribution. Duplicate `plugins[N] plugin.json →` manifest findings from the marketplace run are dropped, notes surface as info, and a run that returns no report is `AB6022` with the CLI's stderr. The native Claude eval gate validates `plugin.json` the same way. (#PR)
