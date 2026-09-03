---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Require provider fixtures where providers are not executed. Once a project's generated `.agent-bundle/routes.d.ts` augmentation declares provider keys, `runAgentRequest`'s `providers`, the test harness `options` argument, and its `context.providers` become required (`AgentRequestProvidersInit`, `RenderRouteContextInit`, `HarnessOptionsArguments`), so a handler typed against `(await agent()).providers.<key>` can never observe an unchecked `undefined` from a custom scope or a route-unit test. Provider-free projects are unchanged. `inspect` now projects only the four-state contract fields of adapter-owned capability rows into component accounting, so extension fields on JavaScript or third-party adapters cannot shadow the canonical capability name or break `inspect --json`.
