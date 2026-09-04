---
'agent-bundle': patch
---

Add the projection-contract proof levels to `agent-bundle/test` (#103 stage 2).

Three levels join `route-unit`, each labeled in its result provenance and in
every failure message, because a pass at one level is never a receipt for
another:

- `mcp-in-memory` — `openInMemoryMcpServer`, `invokeMcpTool`, `readMcpResource`,
  `getMcpPrompt`, and `listMcpSurface` drive the real generated MCP server with
  a real MCP client over the SDK's in-memory transport pair. Protocol-contract
  proof only: no process, no stdio framing, no packed artifact.
- `cli-dispatch` — `invokeCli` runs an argv vector through the routed CLI's own
  shell (#102 stage 2) over the compiled command graph the manifest now
  carries, in-process. Command resolution, argv projection, help, `--version`,
  and the exit-code policy are the product's; the harness supplies only the
  `execute` bridge, and it mirrors the one the generated executable inlines.
  `cliJson` reads the canonical stdout line.
- `packed-stdio` — `openPackedMcpServer` spawns a built artifact's generated
  stdio entry and connects a real MCP client to it. This is the only level here
  that is process evidence.

`renderRouteEvents` returns the ordered render-event stream alongside the final
document, and `expectEvents` asserts over it. The default matcher
(`toContainSequence`) is sequence-tolerant so a legitimate extra `progress` or
`replace` frame cannot turn a passing render red, while a missing frame, a
reordering, or a regressed ordinal still fails.

The test manifest gains `cliCommands`, the compiled routed-CLI command graph
from the same compiler pass, so the dispatch level never recompiles it.
`expectDocument` gains `toContainContext` for the context nodes an event route
returns to its host.

Event routes now render with the props the public contract defines —
`{ canonical, native, signal }`, the same unwrapping the generated Flight
worker performs — instead of the raw invocation payload. A route written
against `AgentEventRouteProps` previously received `undefined` for both.

Internally, the generated MCP server's warm Flight host, route registration,
and MCP projection move out of the entry template into the shared
`agent-bundle/mcp-server-runtime` module the generated entry aliases, so the
in-memory level exercises the artifact's own code rather than a second copy of
it. Generated-entry behaviour is unchanged.
