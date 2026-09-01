---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Cleanup pass over the Wave 3.5 Effect migration: harden the sqlite
connection and Flight reader finalizers against masking the original
failure, consolidate the state drivers' duplicated pending-open lifecycle
tracking, remove the dead epoch lease registry and unused `runSyncExit`
boundary exports, and trim migration-narration comments. No public API or
behavior change.
