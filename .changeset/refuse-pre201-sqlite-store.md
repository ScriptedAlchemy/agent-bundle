---
"@agent-bundle/runtime": minor
---

Fail `createSqliteStateDriver({ root }).open()` from `@agent-bundle/runtime/state/sqlite` with a typed `corrupt` `AgentStateError` when the root holds a pre-#201 `<sanitized id>-<12 hex of utf8(id)>.sqlite` store and no store under the current name. Previously an empty store opened beside it silently. The error names the old file: move it and its `-wal`/`-shm` sidecars out of the state root, or delete them, and the next open creates a fresh store. The old store is never adopted or migrated. (#854)
