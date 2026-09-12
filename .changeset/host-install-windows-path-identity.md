---
"agent-bundle": patch
---

On Windows, `createProjectContext` now judges existing project paths by on-disk identity so 8.3 aliases and native config paths no longer raise `AB7001`, while paths that are allowed not to exist yet stay lexical; development host install replaces directory junctions by moving the previous pointer aside; directory FlushFileBuffers `EPERM` is tolerated with the existing `EACCES`/`EINVAL` gap; and a declared state root whose parent is a file records as unproven (`EEXIST`) instead of failing install. (#787)
