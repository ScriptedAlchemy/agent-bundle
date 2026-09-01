---
"@agent-bundle/runtime": minor
---

`RscMcpDefinition` gains optional listing-level `title` and `_meta` slots;
`defineOperation` preserves them (with the same JSON wire-boundary
validation as result lowering, deep-frozen) and `createRscMcpServer`
forwards both verbatim into tool registration, so MCP Apps hosts can bind
widgets through `_meta.ui.resourceUri` (#43). The server factory also stops
synthesizing annotation defaults: it emits exactly the hints an operation
declares (`readOnly`, plus `destructive` / `idempotent` / `openWorld` when
present), because an absent hint carries MCP-spec default semantics on the
wire that a synthesized `false` silently rewrote.
