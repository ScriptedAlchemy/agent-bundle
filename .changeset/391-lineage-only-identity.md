---
"@agent-bundle/runtime": minor
"agent-bundle": patch
---

`request.lineage` is the only identity-adjacent surface: who a request's parent conversation is, what its root is, and — for subagents — the parent-of-subagent chain. The framework no longer reads, validates, or surfaces operator identity anywhere: the Cursor `workspaceOpen` envelope validator stops inspecting `user_email` (the field still passes through inside `native` untouched), the dev-playground lifecycle fixture drops it, and the docs describe `actor` as the HTTP-authenticated MCP client and nothing more (#391, closed as not planned).

Cursor child binding in the lineage registry is now scoped and self-correcting: a never-seen conversation on a tool hook binds to a pending `subagentStart` only when exactly one is pending in the same `workspace_roots` (nodes record a digest of the roots, never the paths), so two windows sharing one durable registry never bind each other's children; and a blind binding is undone when the bound conversation later receives `beforeSubmitPrompt`, which a subagent never does, so a chat tab whose prompt predates the registry becomes the root it is while the pending child waits for its real conversation. The `LineageNode` schema gains an optional `workspace` field and the journal gains a `childUnbound` event. Capability tables cite the host trackers (#422/#423/#424) and the Cursor desktop hooks-service evidence (`workspaceOpen` and `sessionEnd` reach plugin-scoped hooks; `sessionStart` is never dispatched on the desktop).
