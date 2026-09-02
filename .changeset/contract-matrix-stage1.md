---
"agent-bundle": minor
---

Add stage-1 generated-plugin contract matrix at the `mcp-in-memory` and packed stdio proof boundaries (#218). `runContractMatrix` runs framework-owned wire-contract checks — surface completeness, fixture coverage, invocation sweep, JSON serialized round-trip, declared additive/closed result compat, version-skew fixtures, negative inputs from advertised JSON Schema, and cancellation hygiene — with project-supplied fixtures only. `runPackedContractMatrix` reuses the same implementation against an already-open packed session for process stdio evidence (including MCP App resource registration), reporting module-backed checks as not-applicable when project source may be absent.
