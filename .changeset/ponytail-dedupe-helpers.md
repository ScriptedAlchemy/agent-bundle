---
'agent-bundle': patch
---

Consolidate duplicated request, JSON, and IP-range helpers onto `dev/http.ts` (`responseJsonOrDestroy`, `badRequest`, `noQuery`), `core/strict-json.ts`, `core/errors.ts`, `core/paths.ts`, and a `net.BlockList`-backed `core/special-ip.ts`; detect entry `main`/default exports with the TypeScript parser instead of a hand-rolled tokenizer. Route diagnostics and responses are unchanged; the MCP App sandbox CSP host check now uses the IANA special-purpose registry, so the `192.31.196/24`, `192.52.193/24`, and `192.175.48/24` blocks are rejected and public space in `192.0/16`, `192.2/16`, `192.88/16`, and `198.51/16` outside the registry is accepted (#660)
