---
"agent-bundle": minor
---

Remove the test-only host-contract smoke harness from `agent-bundle/api`: `evaluateHostContract`, `compareInstalledHostContract`, `compareLocalHostContract`, `parseHostContractManifest`, `parseRedactedEventEnvelopes`, `nativeHostContractComparisonEnabled`, and their `HostContract*`, `CompareInstalledHostContractOptions`, `NativeHost`, and `RedactedEventEnvelope` types are no longer exported; the native Claude and Codex host proofs (`runNativeClaudeSmoke`, `runCodexNativeSmoke`, …) now live in the test suite. (#655)
