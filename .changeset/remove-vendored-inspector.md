---
'agent-bundle': minor
---

Remove the vendored MCP Inspector from the Workbench. The MCP page now has a
single playground presentation; the only surviving derived code is the
first-party MCP App renderer (`src/mcp/app-renderer.tsx`, MIT-attributed to
the Inspector's AppRenderer). Protocol inspection moves to the standalone
Inspector app: the dev server gains opt-in `/api/inspector/status` and
`/api/inspector/launch` routes that spawn `@modelcontextprotocol/inspector`
via npx on demand and return its tokenized URL. Drops the sync-inspector
machinery and the Mantine/react-icons/syntax-highlighter dependency surface
(~737 kB less workbench JS).
