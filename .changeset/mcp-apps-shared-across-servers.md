---
"agent-bundle": minor
---

One MCP App can now be served by several local servers (#42): declaring the
same app name with an identical definition (`entry`, `resourceUri`,
`template`, `_meta`; per-server `targets` may differ) under multiple servers
compiles the view once into one `mcp-apps/<name>.html` output and includes
it in every declaring server's `agent-bundle/mcp-apps` registry, instead of
failing as a duplicate compiled destination. Validation now flags only
conflicting redeclarations of an app name (AB4325) and resource URIs spread
across different app names (AB4330); identical shared declarations pass.
