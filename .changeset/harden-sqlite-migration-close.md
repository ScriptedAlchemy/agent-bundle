---
"@agent-bundle/runtime": patch
---

Fail closed instead of replaying unrecoverable legacy state with a newer
reducer, recover journal-head results from the materialized sqlite head, and
preserve lifecycle errors while closing every open sqlite store.
