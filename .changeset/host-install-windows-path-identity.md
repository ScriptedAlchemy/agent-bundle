---
"agent-bundle": patch
---

On Windows, `createProjectContext` now judges existing project paths by on-disk identity so 8.3 aliases and native config paths no longer raise `AB7001`; missing paths resolve the nearest existing ancestor (so a dangling leaf under an escaping symlink still fails closed) instead of throwing `ENOENT`. `agent-bundle prepack` launches npm's `npm-cli.js` through `process.execPath` and ignores a pnpm `npm_execpath`. Development host install publishes Windows directory junctions with absolute targets and replaces an existing junction by moving the previous pointer aside; directory FlushFileBuffers `EPERM` is tolerated with the existing `EACCES`/`EINVAL` gap; and a declared state root whose parent is a file records as unproven (`EEXIST`) instead of failing install. (#787)
