---
"agent-bundle": minor
---

Remove `protocolEra` from `DevRuntimeMcpConnectionState` (exported from `agent-bundle/api`) and from the dev server's runtime MCP session snapshots. The MCP client never reported a protocol era, so the field was always absent; runtime MCP App previews no longer refuse a live session for lacking it. (#836)
