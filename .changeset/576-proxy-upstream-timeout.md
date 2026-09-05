---
"agent-bundle": patch
---

Make the dev runtime client-surface proxy's upstream request timeout configurable: `RuntimeClientSurfaceProxy.open` accepts a trailing `RuntimeClientSurfaceProxyOptions` with `upstreamRequestTimeoutMs` (default `defaultRuntimeClientSurfaceUpstreamRequestTimeoutMs`, 15 000 ms; a value that is not a positive safe integer within the `setTimeout` ceiling is rejected before the proxy opens). The dev server keeps the 15 s default; the proxy's own deadline tests no longer wait on the real timeout (#584)
