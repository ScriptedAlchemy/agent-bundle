---
"agent-bundle": patch
---

Promote the `permission/request`, `permission/denied`, and `stop/failure` canonical event-route families. `permission/request` projects allow/deny decisions through the pinned PermissionRequest output contract on Claude Code and Codex (input rewrite stays fail-closed as reserved upstream); `permission/denied` and `stop/failure` are observation-only Claude families with fail-closed rejection of decision or context output. Codex permission-request wire schemas are byte-pinned from the rust-v0.147.0 tag; hosts without a documented native event carry dated `unavailable` capability rows.
