---
"agent-bundle": patch
---

Stage the throwaway artifact behind `listMcp`, `invokeMcp`, `runMcp`, `listHooks`, and `simulateHook` (when no `artifact` is given) and the Codex validator's schema-generation output in Effect `FileSystem` temporary directories that are removed on every exit path, including interruption; results, diagnostics, and thrown errors are unchanged. `agent-bundle` now depends on `@effect/platform-node-shared` (adds `@types/node`, `@types/ws`, `undici-types` to a consumer install, ≈4 MB). (#508)
