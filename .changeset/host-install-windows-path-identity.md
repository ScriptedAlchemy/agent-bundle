---
"agent-bundle": patch
---

On Windows, `createProjectContext` now judges project paths by on-disk identity so 8.3 aliases and native config paths no longer raise `AB7001`, development host install replaces directory junctions by moving the previous pointer aside, and directory FlushFileBuffers `EPERM` is tolerated with the existing `EACCES`/`EINVAL` gap. (#787)
