---
"@agent-bundle/runtime": minor
---

Stop adopting pre-#201 durable SQLite state stores in `createSqliteStateDriver`: a root-mode store still named `<sanitized id>-<12 hex of utf8(id)>.sqlite` is no longer renamed to `<sanitized id>-<sha256(id)[0:16]>.sqlite` and adopted, and a journal table without a `result_state` column is no longer upgraded in place but rejected on open with a typed `corrupt` error. Move old stores and their `-wal`/`-shm` sidecars out of the state root, or delete them, before upgrading. (#837)
