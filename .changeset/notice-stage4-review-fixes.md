---
"@agent-bundle/runtime": patch
---

Fix two #99 stage-4 review findings: retriable attempted notices past `expiresAt` now expire instead of retaining unused attempts, and `acknowledge()` rejects invocations that started before the notice existed so durable acknowledgement receipts can never predate `createdAt`. The package README's Notices section now describes the current handle surface, states, receipts, retry semantics, and route selector.
