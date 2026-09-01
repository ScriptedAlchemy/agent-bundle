---
"@agent-bundle/runtime": minor
---

Add the optional recipient-scoped notice ledger behind the new `./notices`
subpath. It persists detached Agent Document snapshots through the existing
state kernel, exposes only the evidenced v1 states (`pending`, `attempted`,
`expired`, `unavailable`, `withdrawn`), performs publish- and delivery-time
authorization, and records next-event attempts with invocation receipts.
Stateless package-root and plugin consumers ship none of the ledger.
