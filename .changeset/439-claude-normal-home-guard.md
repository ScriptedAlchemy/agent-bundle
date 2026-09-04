---
"agent-bundle": patch
---

Stop the native Claude contract smoke (`runNativeClaudeSmoke`, the `native-host-smoke` Claude source leg) from reporting `claude-native.normal-home.changed` → `harness-failure` on every signed-in turn against Claude Code 2.1.257+. The normal-home guard digested the sibling `.claude.json` whole, and the host rewrites that file's bookkeeping (cached feature flags, first-start and machine identity, notification and usage counters, per-project session statistics) on every start, even under `--no-session-persistence`. The guard now digests `config.json`, `settings.json`, `settings.local.json`, and `plugins/` as before, plus only the user-scope `mcpServers` registrations of `.claude.json` — a first start creating the file, or any bookkeeping rewrite, passes with `normalHome: 'unchanged'`, while adding, changing, or removing a registration or corrupting the file still fails. Fixes #439 (#529)
