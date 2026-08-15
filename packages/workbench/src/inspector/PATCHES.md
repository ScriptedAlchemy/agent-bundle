# Inspector local patches

`001-rstest-inspector-tabs-import.patch` mechanically changes the retained
upstream `inspectorTabs.test.ts` import from `vitest` to `@rstest/core`. It
allows the exact upstream assertions to execute under this repository's Rstest
runner; no assertion or production-source content is changed.

`002-remove-legacy-sse-mcp-types.patch` removes the legacy `SseServerConfig`
export, its `MCPServerConfig` union arm, and the `"sse"` `ServerType` literal.
Workbench accepts only stdio and Streamable HTTP server configurations. Its
scope is `core/mcp/types.ts`; `core/mcp/fetchTracking.ts` and the Network UI
retain their `text/event-stream` tracing for modern Streamable HTTP responses.

Apart from files explicitly targeted by these numbered patches, allowlisted
Inspector files remain byte-identical. Every vendor change must be represented
by a numbered `patches/*.patch` file and recorded by
`scripts/sync-inspector.mjs` in `UPSTREAM.json`.
