---
"agent-bundle": patch
---

Make `inspect --bundler` render lowered Rspack configurations, rename
`BundlerInspectionEntry.kind` from `mcp-apps` to `mcp-app`, require `source`, surface the lowering
reason in `AB7001`, and serve Workbench assets with production cache and content-type headers.
(#566)
