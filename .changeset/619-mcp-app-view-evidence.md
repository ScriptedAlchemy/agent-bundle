---
"agent-bundle": minor
---

Judge MCP App views from compiler evidence: the `ArtifactDependencyAuditPlugin` now sits in every view's Rsbuild compilation, and a module the compilation kept external — through a `tools.rspack` mutator or a function-form `externals`, whatever it was mapped to — fails the view with `AB6005` (`Compiled MCP App view "mcp-apps/<name>.html" keeps … external …`), since a browser document has no allowable external. (#627)
