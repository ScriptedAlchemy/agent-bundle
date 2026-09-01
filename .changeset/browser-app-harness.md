---
"agent-bundle": minor
---

Add the browser-app proof level to the consumer test harness (#103 stage 3).
`agentBundleBrowserRstest()` from `agent-bundle/rstest` compiles every declared
MCP App once per pool run through the production Rsbuild profile and configures
an Rstest browser pool; the new browser-safe `agent-bundle/test/browser`
subpath ships `mountBrowserApp`, which mounts the compiled self-contained HTML
in a sandboxed iframe over the product's own MCP App bridge with test-supplied
binding operations, consent decisions, and captured traffic. The test manifest
now carries collision-checked MCP App descriptors from the same compiler pass,
and `compileMcpApps` accepts a per-app target selection alongside the existing
single-target form.
