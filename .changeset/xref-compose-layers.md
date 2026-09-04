---
'agent-bundle': patch
---

Compose every synthesized bundler config through one shared layering (`profile` → `tools.rsbuild` → `tools.rspack` → framework invariants), so a `tools` escape-hatch value reaches the MCP Apps Rsbuild config exactly as it reaches artifact scripts, hooks, MCP entries, the routed CLI bin, and the package build, and `output.cleanDistPath` stays off on every path. No artifact or `inspect --bundler` output changes. (#495)
