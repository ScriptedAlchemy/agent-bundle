---
"agent-bundle": patch
---

Report the new `AB4837` diagnostic from `inspect`, `validate`, `build`, and `dev` when a route module, layout, or provider — or a module it reaches through relative imports — value-imports a compiler-carrying framework entry (`agent-bundle`, `agent-bundle/api`, `agent-bundle/config`, `agent-bundle/eval`, `agent-bundle/rstest`, `agent-bundle/test`, `agent-bundle/test/browser`), naming the file, the specifier, and the helper, instead of failing inside the bundler with `Can't resolve '../events'`; `import type` and type-only usage are not reported (#582)
