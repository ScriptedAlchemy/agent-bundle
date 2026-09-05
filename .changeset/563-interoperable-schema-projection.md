---
"agent-bundle": patch
---

Emit tuple `outputSchema`/`inputSchema` in a projection Cursor's draft-07 validator accepts (`prefixItems` + `items: anyOf` + `minItems`/`maxItems`, never `items: false`), fixing `MCP error -32602 … boolean schema is false` on tuple-bearing `tools/call` results; tool arguments are advertised through the same projection, and 2020-12 validators keep positional precision for closed tuples (a `.rest()` tuple's rest positions are loosened to the union). Host capability tables gain an `mcp.structuredContentValidation` row. (#580)
