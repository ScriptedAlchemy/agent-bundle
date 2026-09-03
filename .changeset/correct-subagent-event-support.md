---
"agent-bundle": patch
---

Correct Claude Code and Codex event-route capabilities for native
`SubagentStart` and `SubagentStop` hooks, including host-specific input
validation, result projection, plugin packaging, and pinned Codex wire-schema
evidence. Resolve the actual Claude or Codex invoker before a composite plugin
route validates input or projects output.
