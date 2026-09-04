---
"agent-bundle": patch
---

Project conventional route `inputSchema` exports into a deterministic,
deep-frozen JSON Schema subset without executing route modules (#105 stage 2).
Supported zod object, scalar, enum, array, optional, default, description, and
validation-only chains now travel through `CompiledRouteGraph` and the route
manifest as an optional `inputSchema` field. Rich schemas remain valid and
simply omit the projection; CLI routes retain their existing `AB4814`
diagnostics and argv behavior.

The Workbench Routes page renders generated scalar, enum, boolean, and
repeatable-array editors with defaults, descriptions, required markers, and
client-side validation. Unprojectable schemas receive an explicit raw-JSON
fallback. Valid tool input can be handed to the existing MCP playground as a
prefilled server, tool, and arguments selection without auto-execution, while
valid CLI input produces a copyable argv invocation.
