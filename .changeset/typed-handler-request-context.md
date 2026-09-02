---
"@agent-bundle/runtime": minor
"agent-bundle": minor
---

Expose the transport-installed `AgentRequestContext` as optional
`context.request` to `defineOperation` handlers while preserving the same
request handle returned by `agent()`. Identity axes remain honest `Observed`
values with typed unavailable reasons when a transport cannot know them.

Document `await agent()` as the route-component context contract and the
`renderRoute(..., { context })` identity-injection seam for tests. Business
input cannot override host, session, actor, workspace, or capability context.
