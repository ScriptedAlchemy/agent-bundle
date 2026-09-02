---
"agent-bundle": minor
---

Add stage-1 generated-plugin contract matrix (`runContractMatrix`) at the `mcp-in-memory` proof level (#218). The matrix runs framework-owned wire-contract checks — surface completeness, fixture coverage, invocation sweep, JSON serialized round-trip, declared additive/closed result compat, version-skew fixtures, negative inputs from advertised JSON Schema, and cancellation hygiene — with project-supplied fixtures only.
