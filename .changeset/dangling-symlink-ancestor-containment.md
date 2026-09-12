---
"agent-bundle": patch
---

Fail closed in `createProjectContext` when a project path walks a dangling symlink: resolve relative `readlink` targets against the physical containing directory, apply authored `..` after each hop instead of flattening `symlink/../leaf`, and propagate `ELOOP` for cyclic payload roots and descendants instead of hashing a repeated target as contained. (#789)
