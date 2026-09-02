---
"agent-bundle": minor
---

Declaration-build failures now report as the dedicated `AB4716` code instead of the `AB5000` catch-all, and carry the TypeScript diagnostics that caused them. When the `lib` dts pass aborts, the package build replays declaration emit over the same synthesized tsconfig using the consumer project's own `typescript`, so every underlying error reaches human and `--json` CLI output with its file, `(line,column)`, `TS` code, and message — plus a recovery hint that emit-only errors such as `TS4023` are invisible to `tsc --noEmit`.
