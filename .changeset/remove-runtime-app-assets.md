---
'agent-bundle': minor
---

Remove the development runtime App-asset path: `DevRuntimeSession.readAsset`, the `/api/runtime/assets` route (now a 400 invalid path), the `DevRuntimeAssetRequest` and `DevRuntimePreparedMcpApp` exports, the prepared-runtime `apps` input, `DevRuntimeStatus.hmrReady`, the `mcp-app` runtime surface kind, the `mcp-protocol`, `resource-selection`, `sandbox/csp`, and `app-bridge` diagnostic phases, and the launch and credential fields on `DevRuntimePreparedMcpServer`, which is now `{ id, name, targets }`.
