---
"agent-bundle": patch
---

Stage the throwaway artifact behind `listMcp`, `invokeMcp`, `runMcp`, `listHooks`, and `simulateHook` (when no `artifact` is given) and the Codex validator's schema-generation output in Effect `FileSystem` scoped temporary directories, provided by `@effect/platform-node`'s `NodeServices.layer` at those API edges. Both directories are now removed on every exit path, including interruption; results, diagnostics, and thrown errors are unchanged. (#PR)
