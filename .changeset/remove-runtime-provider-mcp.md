---
"agent-bundle": minor
---

Remove the runtime provider MCP contract from `agent-bundle/api`. `DevRuntimeSession` no longer has `mcpRegistry` or `clientSurface()`, `createRuntimeMcpRegistry` and the `DevRuntimeMcp*`, `RuntimeMcp*`, `DevRuntimeProviderMcpRegistry`, and `DevRuntimeClientSurfaceEndpoint` types are gone, run inspections (`DevRuntimeInspectionEnvelope`) no longer carry `app`, and `DevRuntimeEventInput` drops the `runtime.mcp.*` events with their `mcpRegistryRevision`, `mcpSessionId`, and `mcpSessionRevision` fields. The Workbench rejects a run inspection that still includes `app` (`AB8206`). `createRuntimeGenerationStore` and the generation store contracts are unchanged.
