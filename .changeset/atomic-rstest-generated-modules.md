---
"agent-bundle": patch
---

Write the `agentBundleRstest()` and `agentBundleBrowserRstest()` generated modules under `.agent-bundle/test` (`meta.mjs`, `route-setup.mjs`, `browser-app-setup.mjs`) atomically, so concurrent Rstest processes never load a partial `agent-bundle/meta` or setup module (#844)
