---
"agent-bundle": patch
"create-agent-bundle": patch
---

Reject the runtime's reserved notice-ledger state id during extraction, mount
each missing route-unit binding independently when the caller overrides only
one of state or noticeLedger, and document `zod` in the cli-tool migration
steps.
