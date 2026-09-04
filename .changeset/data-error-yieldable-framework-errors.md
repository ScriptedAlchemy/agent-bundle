---
"agent-bundle": patch
---

Make the dev seam's and eval service's internal framework error classes (`McpSessionError`, `EpochStoreError`, `DevCoordinatorCloseError`, `ProjectEventHubError`, and the rest of the dev-seam close / request errors) yieldable inside `Effect.gen` through the new `Data.Error`-based bases in `src/effect/errors.ts`. Messages, codes, `instanceof`, JSON output, and stack traces are unchanged; `CodedError`, `DiagnosticError`, every class exported from a package entry, and the emitted hook, MCP, and CLI artifacts keep their plain `Error` bases. (#543)
