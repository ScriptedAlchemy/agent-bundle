---
"agent-bundle": patch
---

Throw the intended unavailable-entrypoint error from the built
`agent-bundle/mcp-apps` stub. The rslib bundle reorders module statements so
the emitted `export default` binding was read before its `const` initializer
ran, surfacing a TDZ `ReferenceError` ("Cannot access 'mcp_apps' before
initialization") on import instead of the stub's message. The stub now throws
through a hoisted function declaration, which survives the bundler's
statement reordering, so importing the built entrypoint reports
"agent-bundle/mcp-apps is available only while Agent Bundle compiles a local
MCP server." as intended.
