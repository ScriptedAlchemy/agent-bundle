---
"create-agent-bundle": patch
---

Run the `create-agent-bundle` scaffolder's filesystem work (template copy, `package.json`/config/README rewrites, local `file:` tarball inspection, target-directory check) on Effect's `FileSystem` and `Path` services, provided once by `@effect/platform-node`'s `NodeServices.layer` at the `create-agent-bundle` bin entry. Scaffolded files, messages, and exit codes are unchanged (`UsageError` still exits 2 and filesystem failures still report the Node error text); the self-contained `dist/index.js` bundle grows from 74 kB to 457 kB and the published tarball from 33 kB to 110 kB. (#501)
