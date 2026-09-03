---
"agent-bundle": patch
---

`agentBundleRstest()` and `agentBundleBrowserRstest()` now alias `agent-bundle/meta` to a generated identity module (`.agent-bundle/test/meta.mjs`) written from the same compiler pass with the same `generatedMetaModuleSource` the build injects, so a source module importing `{ name, version, packageName, packageVersion }` loads under unit, route-unit, `renderRoute`, and `invokeCli` tests with the identity `package.json` and `agent-bundle.config.ts` declare instead of failing at import (#386). The published `agent-bundle/meta` module reached outside every compiled surface now throws the structured `AB4760` diagnostic — code, message, and the exact recovery (run under the preset, or alias the specifier in a custom runner) on the thrown error — rather than a bare `Error`.
