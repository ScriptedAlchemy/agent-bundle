---
"agent-bundle": patch
---

Read the `errors` array from `claude plugin list --json` so a plugin Claude Code refused to load is no longer reported healthy: `agent-bundle doctor --host claude` reports the installed copy as `load-failed` (`AB7325`, error) with the host's message verbatim — instead of `current` — and marks the inventory entry and `--plugin-dir` registration proof `failed`; `agent-bundle install claude` fails with `AB7006` when the freshly installed or byte-identical existing copy carries `errors`. The pinned Claude `plugin` schema now admits the documented additional-hook-file forms of the manifest `hooks` field but rejects `"./hooks/hooks.json"` (`AB6012`), the auto-loaded path Claude Code refuses as a duplicate hooks file. (#PR)
