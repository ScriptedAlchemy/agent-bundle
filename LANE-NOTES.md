# L4 — invocation client and backends

## Commits

- `feat(workbench): unify route invocation backends`
- `STUBS (drop on integration)` — drop this final commit after L5 rewires
  `main.tsx` and the MCP type imports described below.

## Added

- `packages/workbench/src/application/invocation-client.ts`
  - `InvocationClient({ foreground })`
  - `invoke(request, signal?)`, `list(limit?, signal?)`, `read(id, signal?)`
  - strict decoders for the complete `RouteInvocation` and
    `RouteInvocationSummary` wire shapes
  - the only `InvocationClientError` declaration (`code`, `status?`,
    `diagnostics?`)
- `packages/workbench/src/application/invocation-model.ts`
  - `InvocationState`, `InvocationAction`, `reduceInvocationState`
  - guarded strict-JSON `readLastInput` / `writeLastInput`
  - `selectBackend`, `invocationSummaryOf`
- `packages/workbench/src/application/dev-server-backend.ts`
  - dev-server invocation/history/read delegation
  - route-filtered history
  - `route.invocation` project-event subscription
- `packages/workbench/src/application/runtime-backend.ts`
  - matches tools/resources by runtime `mcp.<name>` surface and events to hook
    surfaces
  - invokes the runtime provider, reads Agent Document events, and maps
    completed runs to `RouteInvocation`
  - maps runtime history/read/subscription into the common envelope
- `packages/workbench/src/runtime-controller.ts`
  - extracted kept Runtime engine: reducer controller, effect draining,
    project-event buffering, and bootstrap retry policy
- `packages/workbench/src/runtime-view-contracts.ts`
  - non-page MCP App preview and handoff contracts formerly declared by
    `runtime-stage.tsx` / `runtime-playground.tsx`
- focused tests:
  - `invocation-client.test.ts`
  - `invocation-model.test.ts`
  - `dev-server-backend.test.ts`
  - `runtime-backend.test.ts`
  - `runtime-controller.test.ts`

## Deleted

Runtime destination UI and page-only tests:

- `runtime-evidence.tsx`
- `runtime-inspector.tsx`
- the implementation of `runtime-playground.tsx`
- the implementation of `runtime-stage.tsx`
- Runtime playground/stage/inspector/capture browser and unit tests

The final commit temporarily restores `runtime-playground.tsx` and
`runtime-stage.tsx` as integration-only stubs because the L5-owned `main.tsx`
and MCP-owned modules still import the old paths on this isolated branch.
Dropping that final commit completes their deletion.

## Production import graph after integration

- L5 `main.tsx` → `invocation-client.ts` → `runtime/agent-document-client.ts`
- L5 `main.tsx` → `dev-server-backend.ts` → `invocation-client.ts`
- L5 `main.tsx` → `runtime-backend.ts` →
  `runtime-controller.ts`, `invocation-model.ts`,
  `runtime/agent-document-client.ts`
- L5 `main.tsx` → `runtime-client.ts` →
  `runtime/agent-document-client.ts`
- L5 `main.tsx` → `runtime-controller.ts` → `runtime-model.ts`,
  `runtime-client.ts`, `runtime/agent-document-client.ts`
- MCP App preview/handoff modules → `runtime-view-contracts.ts` →
  `runtime-model.ts`
- `lifecycles/lifecycle-client.ts` and the new invocation/runtime clients keep
  `runtime/agent-document-client.ts` live.
- L3 owns `runtime/agent-document-stage.tsx` and its move into the Application
  renderer. `runtime/agent-document-atoms.ts` lost its old production importer
  when `runtime-inspector.tsx` was deleted; L3 must either import it from the
  moved renderer or delete it and update `atom-error-channels.test.ts`.

## Exact L5 integration

Use the existing shared foreground authority and project event source:

```ts
const invocationClient = new InvocationClient({ foreground: foregroundClient });
const devServerBackend = createDevServerBackend({
  client: invocationClient,
  events: { subscribe: (listener) => projectClient.subscribeEvents(listener) },
});
const runtimeBackend = runtimeController === undefined
  ? undefined
  : createRuntimeBackend({ controller: runtimeController, runtimeClient });
const backends = runtimeBackend === undefined
  ? [devServerBackend]
  : [runtimeBackend, devServerBackend];
```

Pass `backends` to `RouteWorkspace`. Runtime must remain first so
`selectBackend` prefers its matching RSC surface and falls back to the
dev-server backend for every other invokable route.

The current source does **not** have a `workbench-capabilities.ts` `runtime`
field. Runtime is actually gated in `main.tsx` by
`status.runtime?.state === 'configured'`, followed by a successful
`RuntimeClient.bootstrap()`. Preserve that gate (or use L5's replacement
capability field if L5 adds one).

After rewiring:

1. import `createRuntimeEventBuffer`, `createRuntimePlaygroundController`,
   `runtimeBootstrapRetryPlan`, and `RuntimePlaygroundController` from
   `runtime-controller.ts`;
2. import App preview/handoff types from `runtime-view-contracts.ts` in
   `main.tsx`, `mcp/mcp-page.tsx`, `mcp/mcp-app-preview.tsx`, and
   `mcp/runtime-mcp-handoff.ts`;
3. remove the Runtime navigation destination and `RuntimePlayground` render;
4. drop the final `STUBS (drop on integration)` commit.

## Cross-lane dependencies and risks

- L1 must add `route.invocation` to `ProjectEventMessage`, the browser
  `projectEventTypes` list, and its strict project-event payload decoder. This
  lane uses the agreed local structural view until that union lands.
- Runtime surfaces do not carry an MCP server id. A runtime tool/resource is
  matched by the provider convention `mcp.<name>`; duplicate names across
  servers are therefore indistinguishable and fall back to the dev-server
  backend unless the runtime contract later gains server identity.
- Runtime history comes from the controller's bootstrapped/live run model; the
  Runtime client has no independent list method.
- `runtime/agent-document-stage.tsx` was not touched, per L3 ownership.
- No changeset: Workbench is private and this lane changes no publishable
  package.

## Verification

- `pnpm build`
- `npx tsc --project packages/workbench/tsconfig.json --noEmit`
- `pnpm lint`
- 96 focused tests passed across the four new invocation suites and retained
  Runtime client/model/controller/contract/handoff suites.

## Proposed changeset line

None (private Workbench-only change).
