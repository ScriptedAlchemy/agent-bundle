---
"agent-bundle": patch
---

Remove the unused runtime MCP App renderer from the bundled Workbench. App previews keep rendering through the server-issued sandbox frame; the package no longer ships `dist/workbench/src/mcp/APP-RENDERER-LICENSE`, and `NOTICE` and `THIRD_PARTY_NOTICES` drop the MCP Inspector `AppRenderer` attribution.
