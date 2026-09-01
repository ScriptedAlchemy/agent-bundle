---
"@agent-bundle/runtime": patch
---

Preserve durable state across the sqlite filename transition, recover legacy
journal results before schema migrations rebase history, keep reset
idempotency inputs unchanged while migrating their committed results, make
in-memory migrations atomic, and surface sqlite close failures on otherwise
successful shutdown.
