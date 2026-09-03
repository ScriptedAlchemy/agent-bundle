---
"agent-bundle": patch
---

The `agent-bundle/test` harness now mounts conventional request context providers (`src/providers/*`) for every manifest-backed request scope — `renderRoute`, `renderRouteEvents`, `invokeCli` (plain, rendered, and projected MCP commands), and the in-memory MCP helpers — exactly as the generated entries do: discovered from the compiled manifest, executed once per request in the same deterministic key order with the same surface-specific `invocation`, fail-closed with the same messages, and seeded with a `processLifetime` process identity. Passing `context.providers` opts out and mounts the explicit map verbatim. The test manifest gains `providers`, the generated Rstest setup registers provider loaders, and the provider execution contract shared by the generated scopes and the harness lives in one module.
