---
"agent-bundle": patch
---

Alias `agent-bundle/meta` automatically in `agentBundleRstest()` and `agentBundleBrowserRstest()` (`agent-bundle/rstest`), so a source module that imports `{ name, version, packageName, packageVersion }` loads under unit, route-unit, `renderRoute`, and `invokeCli` tests with the identity `package.json` and `agent-bundle.config.ts` declare — the same values a build stamps — instead of failing at import. Throw the new `AB4760` diagnostic from the published `agent-bundle/meta` module when it is reached outside every compiled surface and outside those presets; its `code` and `recovery` name the fix (run the pool through the preset, or alias the specifier in a custom runner). (#416)
