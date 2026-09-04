---
"agent-bundle": patch
---

Stop requiring hand-enumerated MCP App fixtures in `runPackedContractMatrix`, `runInstalledHostContractMatrix`, and `runDevEpochContractMatrix`: app routes are auto-covered at those levels with the new `apps: 'auto'` default (`coverage` passes with a reason naming the `ui://` resource sweep; `apps: 'explicit'` restores the fixture requirement), declare a resource or app fixture as `{ kind: 'resource' }` (`ContractResourceFixture`; legacy `{}` still accepted), keep apps `not-applicable` at `mcp-in-memory`, and report the `cancellation` check as `not-applicable` ("invocation completed before abort; use an input that stays in flight") instead of a `contract-violation` when the aborted call settled before `abortAfterMs` elapsed. The `agent-bundle/test` docs now state per level whether apps are covered. No diagnostic codes change. (#417)
