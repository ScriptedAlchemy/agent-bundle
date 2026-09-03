---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Make `request.lineage` the only identity-adjacent surface — parent conversation, root, and the parent-of-subagent chain — and stop reading operator identity anywhere: the Cursor `workspaceOpen` event-route validator no longer inspects `user_email` (the field passes through inside `native` untouched), and `actor` is documented as the HTTP-authenticated MCP client only. Bind a never-seen Cursor conversation to a pending `subagentStart` only when exactly one is pending in the same `workspace_roots`, and undo a blind binding (re-rooting anything started beneath it) when that conversation later carries a root-only event such as `beforeSubmitPrompt`, so a chat tab whose prompt predates the registry resolves as a root instead of another conversation's subagent. (#444)
