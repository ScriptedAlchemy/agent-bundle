---
"@agent-bundle/runtime": minor
---

Stop adopting pre-#201 durable SQLite state stores in `createSqliteStateDriver`: a root-mode store still named `<sanitized id>-<12 hex of utf8(id)>.sqlite` is left on disk unread and a fresh `<sanitized id>-<sha256(id)[0:16]>.sqlite` store opens beside it, and a journal table without a `result_state` column is no longer upgraded in place but rejected on open with a typed `corrupt` error. Delete or recreate old stores before upgrading. (#837)
