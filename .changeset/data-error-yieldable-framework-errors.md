---
"agent-bundle": patch
---

Raise the dev seam's and eval service's internal framework errors that no public declaration reaches (`DevCoordinatorCloseError`, `RuntimeMcpRegistryError`, `RuntimeGenerationStoreError`, `DevRuntimeProviderLoadError`, `ScriptPlaygroundFailure`, `LifecycleReplayRequestError`, `ArtifactInspectionServiceError`, `HookSimulationAbortError`, `CodexEvalHarnessError`, `SmokeStepError`, and their close / abort siblings) through the new `Data.Error`-based bases in `src/effect/errors.ts`, so `agent-bundle dev` and `agent-bundle eval` programs can `yield*` them inside `Effect.gen`. Messages, codes, `instanceof`, JSON output, and stack traces are unchanged; `CodedError`, `DiagnosticError`, every class on a public entry's declaration graph, and the emitted hook, MCP, and CLI artifacts keep their plain `Error` bases, and no `effect` type reaches a public `.d.ts`. (#543)
