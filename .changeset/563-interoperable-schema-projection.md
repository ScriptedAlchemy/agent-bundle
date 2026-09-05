---
"agent-bundle": patch
---

Emit tuple `outputSchema`/`inputSchema` in a projection Cursor's draft-07 validator accepts (`prefixItems` + `items: anyOf` + `minItems`/`maxItems`, never `items: false`), fixing `MCP error -32602 … boolean schema is false` on tuple-bearing `tools/call` results and arguments while 2020-12 validators keep positional precision. (#580)
