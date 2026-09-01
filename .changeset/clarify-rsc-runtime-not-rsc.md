---
"@agent-bundle/runtime": patch
---

Docs-only clarification of the operation/JSX model (#88). The published
README now states explicitly that the package is **not** a React Server
Components renderer or runtime and that no Flight transport is involved: it
is a synchronous React-element protocol DSL (an "MCP result DSL") whose
`lowerMcpResult`/`lowerHookResult` walk an element tree and lower it into
plain protocol results. The README also spells out the operation model — an
operation is a host-neutral use-case definition whose shared core
(`id`/`inputSchema`/`execute`/`resultSchema`) runs identically under the CLI
and MCP projections, `render` is consumed only by MCP, and the CLI prints
validated JSON — and the npm `description` field no longer claims "React
Server Component primitives". No runtime code or export surface changes.
