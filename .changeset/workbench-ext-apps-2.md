---
"agent-bundle": patch
---

Host MCP App previews in the `agent-bundle dev` Workbench on `@modelcontextprotocol/ext-apps` 2.0.0. The MCP Apps wire protocol is unchanged, so views built on ext-apps 1.x or 2.x both render, and cancelling a View request still aborts a pending consent prompt or open-link, download, and display-mode action. Error responses a View receives follow ext-apps 2.0: invalid params on `ui/*` requests report `-32602` instead of `-32603`, and messages drop the `MCP error N:` prefix. The `AB4772` size guidance now gives the ext-apps 2.x view floor, about 249 kB (65 kB gzip). (#815)
