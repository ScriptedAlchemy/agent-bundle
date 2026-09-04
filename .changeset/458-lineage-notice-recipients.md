---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Address a notice to one agent conversation or to a whole conversation tree: `AgentRecipient` gains `conversation` (matches `request.lineage.conversation` exactly) and `root` (matches every request whose `request.lineage.root` is that id), matched in conjunction with the existing `actor` / `host` / `session` / `workspace` axes at admission, inbox reads, `resources/updated` eligibility, and acknowledgement. `AgentNoticePrincipal` carries the request's `lineage`, which every generated surface (event routes, MCP tools, routed CLI, rendered scripts) now mounts; unresolved lineage never matches a lineage-addressed recipient. The ledger journals only `{ conversation, root }` of the admitting lineage as an additive optional field — no state-definition version bump, journals written before the axes replay unchanged. `notices.publish()` rejects blank `conversation` / `root` with `invalid-input`. `examples/worktree-proximity` addresses its proximity notices to the other actor's conversation instead of its worktree. (#458)
