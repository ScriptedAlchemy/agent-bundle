---
"agent-bundle": minor
---

Prove self-containment from compiler evidence: a compiler service lowers every host-pack surface and package-build entry and fails the build with `AB6005` at compile time for any module Rspack kept external that is not a Node built-in or an emitted sibling, whatever spelling the bundle uses; the `tools` hatch can no longer externalize a dependency — `tools.rsbuild.output.autoExternal` other than `false` or a static non-built-in `externals` entry is rejected at config validation with the new `AB4725`, and function-form externals are judged by the compilation's evidence. The emitted-module walk remains as defense in depth until #619 completes. (#PR)
