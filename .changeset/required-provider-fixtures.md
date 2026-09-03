---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Require provider fixtures wherever conventional providers do not run. Once a project's generated `.agent-bundle/routes.d.ts` augmentation declares provider keys, `runAgentRequest`'s `providers` (`AgentRequestProvidersInit`), the `renderRoute` / `invokeCli` / in-memory MCP harness `options` argument (`HarnessOptionsArguments`), and its `context.providers` (`RenderRouteContextInit`) become required, so a handler typed against `(await agent()).providers.<key>` never observes an unchecked `undefined` from a custom scope or a route-unit test; provider-free projects are unchanged. Make `agent-bundle inspect` project only the four-state contract fields of adapter-owned capability rows into component accounting, so extension fields on JavaScript or third-party adapters cannot shadow the canonical capability name or break `inspect --json`. (#409)
