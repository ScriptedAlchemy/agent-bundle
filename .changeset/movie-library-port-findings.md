---
"@agent-bundle/runtime": minor
"agent-bundle": minor
---

Fixes found while re-porting a real external plugin onto route mode
(#380, #381, #383):

- A `mcp.servers.<id>` declaration for a route-generated server now
  **augments** that server — `env`, `args`, `targets`, `apps`, and
  `transport: 'stdio'` apply — instead of failing `AB4304`/`AB4322`. Redeclaring
  `entry`, `command`, or `url` beside `routes.servers.<id>: 'generated'` is
  the new precise `AB4340` error; without an explicit mode it stays `AB4800`.
- `Agent.Result metadata` projects to `CallToolResult._meta` (an object,
  JSON-snapshotted like `structuredContent`; a non-object fails the projection
  closed with `McpProjectionError('invalid-result-metadata')`). The
  `mcp-in-memory` harness result exposes `_meta`.
- Generated tools advertise `outputSchema` only when the route's
  `resultSchema` describes an object; text-only routes (for example
  `resultSchema = z.undefined()`) advertise none and return no
  `structuredContent`, as the MCP specification requires.
- The `typescript-5` parser alias is bundled into the package instead of
  shipped as a dependency, so `npm install agent-bundle` never links a `tsc`
  bin over the consumer's own TypeScript.
