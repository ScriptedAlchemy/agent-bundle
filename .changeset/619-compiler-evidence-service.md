---
"agent-bundle": minor
---

Prove self-containment from compiler evidence for every host-pack surface and package-build entry. Reject `tools.rsbuild.output.autoExternal` other than `false` and static non-built-in `externals` with `AB4725`; judge function-form externals from compiler evidence and fail with `AB6005` when Rspack keeps anything except a Node built-in or emitted sibling external. Keep the emitted-module walk as defense in depth until #619 completes. (#623)
