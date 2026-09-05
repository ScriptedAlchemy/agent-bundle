---
"@agent-bundle/runtime": patch
---

Configure sqlite state storage under the busy timeout: `createSqliteStateDriver` now retries the `PRAGMA journal_mode = WAL` switch on the first open of a state file for up to `busyTimeoutMs` while another process holds the write lock (SQLite never routes that read-to-write lock upgrade through `busy_timeout`), so two processes opening one workspace-durable state file no longer fail with `unavailable` / `database is locked` during setup. Extended SQLite result codes (`SQLITE_BUSY_*`, `SQLITE_CORRUPT_*`) now map to the same typed `unavailable` / `corrupt` errors as their primary codes (#PR)
