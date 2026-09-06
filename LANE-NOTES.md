# Lane B0 integration notes

Merged `wb600-pr2a-exec` (`55be005b0f`) into the trace integration branch and
resolved all conflicts with PR 2a authoritative for the invocation contract
and execution path.

## Conflict resolutions

- `route-invocation.ts`, service, child, browser decoder/model, and tests keep
  `routeId` + optional `surface`/`input` plus top-level `correlationId`; legacy
  invocation `mode`, `args`, `event`, and `requestId` fields were removed.
- The service keeps PR 2a's production default, explicit `unit-render`, leased
  epoch admission, queue-aware abort, `surface`, `outcome`, and measured
  telemetry. It also publishes invocation lifecycle and child kernel entries
  through `TracePublisher`.
- The production renderer still retains kernel events on the final result and
  now sends each event live through child IPC as `{ type: "trace" }`. The
  unit-render path keeps the trace branch's process-local event observer.
- Hook wrapper generation keeps PR 2a's shared `prepareRouteInvocation`
  preflight path while attaching the trace receipt observer and sending the
  receipt in `finally`.
- Workbench route results keep the trace branch's correlated live timeline and
  PR 2a's separate status/outcome badges. English and Chinese Workbench docs
  retain both the invocation contract/outcome text and Trace HTTP reference.
- Route service, foreground integration, MCP session correlation, Workbench,
  packed-release, trace-page, and audiobook acceptance tests retain both
  branches' coverage. Trace fixtures were updated to the `surface` contract
  and honest telemetry.
- `docs/diagnostics.md` retains the trace ranges `AB8240`–`AB8242` and
  `AB8247`–`AB8249` plus PR 2a's `AB8239` and `AB8250`–`AB8255`.
- Both issue changesets remain: `wb600-pr2a-execution-parity.md` and
  `wb600-application-explorer.md`; the PR 2a changeset was not edited.

## Diagnostic allocation

No renumbering was required. The trace branch does not use `AB8239` or
`AB8250`–`AB8255`.

## Ambiguities

- The unified trace timeline replaced PR 2a's route-history trace list. To
  preserve PR 2a's separate execution status and application outcome display,
  the current invocation verdict is shown above the correlated timeline.
- Unit-rendered event routes publish both the wrapper's kernel phases and any
  phases explicitly emitted by route code; tests identify each execution by
  `executionId`.

## Gate results

- `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit` — pass
  (4,333 passed, 6 skipped).
- `pnpm test:route-unit` — pass (89 passed).
- `pnpm test:integration:run` — pass (1,151 passed, 4 skipped).
- `pnpm docs:site:build` — pass (locale parity; 0 broken links across 28,601
  anchors).
- `git diff --check` and `git diff --cached --check` — pass.

TraceDecay MCP discovery and its CLI daemon were unavailable, so build and
typecheck diagnostics came directly from the repository gates.
