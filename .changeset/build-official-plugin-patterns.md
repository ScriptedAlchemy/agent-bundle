---
'agent-bundle': patch
---

Register the package build's `__filename`/`__dirname` ESM shim through Rsbuild's `processAssets` plugin hook instead of a hand-rolled Rspack plugin class inside `tools.rspack`, matching how Rsbuild's own asset plugins hang post-build rewrites. The emitted `dist/**` is byte-identical; no artifact, config key, or CLI output changes. (#PR)
