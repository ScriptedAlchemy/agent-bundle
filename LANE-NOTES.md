# Lane B1 — live route invocation transport

## Built

- Production `AgentRenderEvent`s now cross the existing child IPC as
  `{ type: "render", event }` when the child reads each event.
- `RouteInvocationService.start()` returns the running id immediately while
  `invoke()` keeps its completed-envelope contract. Subscribers replay retained
  `render`/`trace` messages and then receive live messages plus one terminal
  `final`.
- Running invocations retain the newest 256 render events. Dropping older
  events adds one `truncated` marker whose `dropped` count is updated.
- `cancel(id)` uses the invocation's existing abort path. The child is
  terminated before the final envelope resolves with `status: "cancelled"` and
  no `outcome`; Trace publishes `invocation.cancelled`.
- `POST /api/routes/invocations` with `stream: true` returns `202` with the
  running record.
- `GET /api/routes/invocations/<id>/stream` serves replay plus live SSE and
  closes after `final`.
- `POST /api/routes/invocations/<id>/cancel` returns the cancelled envelope
  with `202`; an already-final invocation returns `AB8256` with `409`.
- Executable and event route workspaces consume the stream, render live
  Suspense/progress snapshots, expose Cancel while running, and settle on the
  unchanged final envelope. Test ids cover Cancel, running status, and progress.

## Unit-render behavior

`renderRouteEvents` returns an array rather than an incremental stream. The
child therefore forwards its events in order immediately after rendering and
before its final result message; the final `events` array is unchanged.

## Tests and gates

- `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit` — pass
  (290 files; 4,340 passed, 6 skipped).
- `pnpm test:route-unit` — pass (10 files; 89 passed).
- `AGENT_BUNDLE_WORKBENCH_PREBUILT=1 AGENT_BUNDLE_PACKAGE_PREBUILT=1 pnpm exec rstest --config rstest.integration.config.ts packages/agent-bundle/tests/route-invocation-dev-server.test.ts packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts`
  — pass (2 files; 4 passed).
- `pnpm docs:site:build` — pass (locale parity; 0 broken links across 28,273
  anchors).
- Focused service and Workbench route-workspace unit tests — pass.
- `git diff --check` — pass.

## Deliberately not built

- No new service class, transport dependency, result envelope, or telemetry.
- Browser acceptance fixtures remain lane B2's responsibility.

## Open concerns

None.
