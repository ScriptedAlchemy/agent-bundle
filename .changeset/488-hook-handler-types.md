---
'agent-bundle': patch
---

Export the typed config hook handler contract from `agent-bundle` and `agent-bundle/config`: `HookHandler<E>`, `HookEvent<E>`, and `HookResult<E>` for every `CanonicalHookEvent` (now exported too, with `AgentBundleHookEntry` and `AgentBundleHookInput`), the per-event payloads (`SessionStartHookEvent`, `BeforeToolHookEvent`, `AfterToolHookEvent`, `StopHookEvent`, `AgentStartHookEvent`, `AgentStopHookEvent`, `WorkspaceOpenHookEvent`, `HookEventBase`, `HookEventPayloads`), the second handler argument `HookHandlerContext`, and the tables the types derive from (`hookResultContract`, `hookEventFields`). `export default ((event) => ({ … })) satisfies HookHandler<'sessionStart'>` makes an illegal result — a denying `sessionStart`, `reason` beside `continue`, `updatedInput` on `stop` — a `tsc` error; the generated wrappers' runtime validation is unchanged and a test holds the types to exactly what every host wrapper accepts. Fixes #488. (#529)
