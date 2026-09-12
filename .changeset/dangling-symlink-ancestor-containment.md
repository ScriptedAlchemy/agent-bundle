---
"agent-bundle": patch
---

Fail closed in `createProjectContext` when a project path walks a dangling symlink: walk raw `readlink` targets in filesystem order without collapsing `pivot/../missing`, keep POSIX backslashes as filename data, inspect symlinks before the JS `realpathSync` shortcut, and retain the resolved prefix so missing descendants do not re-walk every parent. Propagate `ELOOP` for cyclic payload roots and descendants instead of hashing a repeated target as contained. (#789)
