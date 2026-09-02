---
"@agent-bundle/runtime": minor
"agent-bundle": minor
---

Mount the #98 state kernel and #99 notice ledger into generated request
scopes (#233). `@agent-bundle/runtime/mount` exports
`createGeneratedRuntimeState`, which owns the project state store and the
notice ledger over one driver and returns typed-failing handles when that
driver cannot open. `createWarmFlightHost` accepts optional `runtimeState`
ownership so the warm host closes the generated owner with the process.
Conventional `src/state.ts` default-exports `defineState({ ... })` with
statically extracted literal `id` and `lifetime` (`AB4818`–`AB4820`);
`state: false` opts out. Generated MCP flight workers, routed CLI bins, and
rendered workers and scripts mount `state` and `noticeLedger` into every
request scope — memory driver for `request`/`process` lifetimes,
`node:sqlite` at the `AGENT_BUNDLE_PLUGIN_ROOT`-anchored `state/` root for
`workspace-durable`, and a cwd `.agent-bundle/state` fallback for package
bins. Event invocations run notice admission once in the render scope with
invocation identity forwarded from the host process. Stateless projects
emit none of this. The test harness auto-mounts declared state at
route-unit level, and `openInMemoryMcpServer` accepts a state owner.
