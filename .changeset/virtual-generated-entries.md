---
"agent-bundle": patch
---

Serve generated wrapper entries and registry modules from memory through
Rspack's `experiments.VirtualModulesPlugin` instead of writing throwaway
files into the staged output root. Every generated module keeps its
deterministic path under the reserved `.agent-bundle-virtual/` namespace,
but the path is now guaranteed-nonexistent: builds no longer create or
delete scratch files inside the artifact tree, and the resolved bundler
config is asserted to retain both the plugin and the redirected wrapper
entry. A narrow feature check turns an upstream removal of the experimental
plugin into an actionable diagnostic. All self-containment invariants are
unchanged: reserved-specifier externals and alias shadowing are still
rejected, emitted bundles are still scanned for residual reserved imports,
and dist cleaning stays pinned off to protect sibling outputs in the shared
staged root.
