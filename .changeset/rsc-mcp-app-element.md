---
"@agent-bundle/rsc-runtime": minor
---

`defineRscAgentBundle` element trees can declare MCP Apps first-class:
`<McpApp>` children of `<McpServer>` lower into the owning server's
`mcp.servers[<name>].apps` record (#42), so `application.config` stays the
single source of truth for widget-bearing plugins instead of a config-side
splice. App names, entries, templates, `ui://` resource URIs, target
subsets, and JSON `_meta` are validated during lowering; app `targets`
default to the owning server's targets. The same `<McpApp>` may be declared
on several servers when the definitions are identical — the shared-app case
the compiler now supports — while conflicting redeclarations and resource
URIs spread across different app names are rejected.
