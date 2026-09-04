---
"agent-bundle": patch
---

Report every local Cursor install failure as an `AB7004` diagnostic for the `cursor` host: a Cursor home that exists but cannot be inspected (for example an unreadable `~/.cursor`) now surfaces as `AB7004` with `target: 'cursor'` like every other Cursor install failure, instead of a bare error. Successful installs, `AB7002`/`AB7003`/`AB7005` refusals, and the Claude/Codex installers are unchanged. (#PR)
