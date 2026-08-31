---
"@agent-bundle/rsc-runtime": minor
---

Framework mode (RFC #63), runtime side — **breaking removals**. The
structural JSX layer is gone: the `AgentBundle`, `Skill`, `Script`,
`McpServer`, `McpApp`, and `Operation` elements, `defineRscAgentBundle`, and
the `RscAgentBundleApplication` type are removed outright. Structure —
targets, skills, scripts, servers, apps — is declared in
`agent-bundle.config.ts` and file conventions; JSX remains only where
something is rendered (`Mcp.*`/`Hook.*` results, rendered skill bodies).
Their replacement is `defineRscApplication({ name, version, description?,
operations })`: a flat, JSX-free declaration of the runtime identity and the
typed operation catalog, rejecting duplicate operation ids, CLI commands, and
MCP tools. `runRscCli` and `createRscMcpServer` now consume this flattened
application — `createRscMcpServer(application, serverName)` selects the
operations whose `mcp.server` matches and throws for a name no operation
references. The `agent-bundle` peer dependency is dropped; the package no
longer imports config types at all.
