# Lane A7 — outcome vs. execution status

Branch `lane/wb600-pr2a-a7`, from `wb600-pr2a-exec`. Scope: PR 2a addendum §A7 only.
`mode`/`args` (A6) and `epoch-paths.ts` (A9) untouched.

## What changed

`RouteInvocationStatus` keeps one meaning: whether the execution boundary
completed. A completed invocation now also carries `outcome`, the application
result judged by the surface the route ran through. The envelope, the
`route.invocation` project event payload (it is the same `RouteInvocationSummary`),
and the Workbench UI all report the two facts separately; a represented error or
a non-zero exit is never rendered as plain success.

### Result shape

Before:

```ts
interface RouteInvocationSummary {
  status: 'failed' | 'succeeded';
  diagnostics: Diagnostic[];      // empty when the route rendered — even for Agent.Error
  // …
}
```

After:

```ts
type RouteInvocationOutcome =
  | { kind: 'success' }
  | { kind: 'represented-error'; summary: string }
  | { kind: 'process-exit'; exitCode: number };

interface RouteInvocationSummary {
  status: 'failed' | 'succeeded';  // boundary completed / did not
  outcome?: RouteInvocationOutcome; // present on every `succeeded`, absent on `failed`
  // …
}
```

The Workbench decoder (`invocation-client.ts`) enforces `outcome !== undefined
⇔ status === 'succeeded'` on both the envelope and list summaries, so the wire
can never imply success by omission. The history is an in-memory ring buffer,
so there is no persisted pre-`outcome` record to reject.

### How each outcome is detected (production path)

Decided in `RouteInvocationService.invoke` by `invocationOutcome(route, child)`,
from facts the child already reports — nothing is re-derived in the service:

| Outcome | Source of truth | Where it is captured |
| --- | --- | --- |
| `process-exit` / `success` (process surfaces) | `child.exitCode` — set only by a process surface | Plain script: the real child exit status (`runPlainScript`). CLI route, or tool invoked through its CLI projection: the generated bin's own decision — `route-invocation-production.ts` keeps the bin module it already loaded for `prepareRouteInvocation` and calls its new `routeInvocationExitCode(routeId, document)` export, which runs the bin's `resultSchema.parse` → `renderedDocumentExitCode(command.exitCode, …)` (the exact `runRenderedInvocation` rule in `cli-entry.ts`, now one exported function used by both), folding the failures the shell exits 1 on to `1`. Rendered script: the fixed `zero` policy `runGeneratedRenderedScript` uses. `unit-render`: no bin exists, so `route-invocation-child.ts` applies the same `renderedDocumentExitCode` to the manifest command's policy. |
| `represented-error` (MCP / event surfaces) | `child.mcp.isError === true` (what `documentToCallToolResult` in `project-mcp.ts` sets for a non-`success` document) or `document.status !== 'success'`; for event routes, a decision whose `outcome` is `deny`. | `summary` lists the document's `Agent.Error` nodes as `[code] message`, joined by `; `, or `deny: <reason>`. |
| `success` | none of the above | — |

`exitCode` wins when present: a tool invoked through its CLI projection is
judged as a process, because that is the surface the run went through.

`invocationProjection` for `cli`/`script` now reads `child.exitCode` instead of
recomputing an exit code from the result; the service's private
`resultExitCode` copy is deleted.

### Providers

Unchanged: `mounted | failed | unobserved`. `unused` is **not** added. The
worker records provider mounts through `AgentRenderInvocation` observations,
which see a provider mount and its duration but not whether the handler ever
read the provided value: the value is handed over as a plain object, and no
access is instrumented. Claiming `unused` would be invented telemetry, exactly
what A4 forbids. The UI shows provider rows as reported.

### Workbench UI

- Status line: `Completed in N ms` / `Failed after N ms` (the phase), plus an
  `OutcomeBadge` (`Success` / `Represented error · <summary>` / `Exit code N`)
  when the envelope has an outcome. "Succeeded" is no longer used for the
  phase, since success is the outcome's word.
- Trace list (route workspace and event replay tab): `StatusBadge` +
  `OutcomeBadge` per entry; layout switched from a fixed grid to wrapping flex
  so the optional badge does not break columns.
- Event canonical tab: `Execution` and `Outcome` rows.
- `statusLabel` / `outcomeLabel` live in `invocation-model.ts`; the badges in
  `result-tabs.tsx` (imported by both workspaces; placing them in
  `executable-route-workspace.tsx` would create a cycle with
  `event-route-workspace.tsx`).
- The runtime backend (`runtime-backend.ts`, the pre-dev-server path) has no
  process or MCP surface, so it judges the document status alone and omits
  `outcome` when a summary carries no document.

## Tests

- `packages/agent-bundle/tests/route-invocation-dev-server.test.ts`: new
  fixtures `tool:status/refuse` (`Agent.Error`) and `cli:exit`
  (`exitCode: 'result'`). Asserts `represented-error` with `isError: true` and
  the `[refused] Refused: policy` summary; `process-exit` 3 in production and
  `unit-render`, with the generated bin run as a real process exiting 3;
  event `deny` → `represented-error`, `continue` → `success`; `success`
  outcomes on the tool, event, CLI and `route.invocation` payload paths.
- `packages/workbench/tests/invocation-client.test.ts`: decodes all three
  outcomes on envelopes and list summaries; rejects a completed run without an
  outcome, a failed run with one, and an unknown kind (`AB8230`).
- `packages/workbench/tests/invocation-model.test.ts`: label helpers;
  `invocationSummaryOf` carries `outcome`.
- `packages/workbench/tests/route-workspace.test.ts`: the status line and
  Trace render the outcome badge distinctly from the phase and never
  `route-outcome--success` for an error/exit outcome.
- Fixtures gained `outcome: { kind: 'success' }`; `lifecycles.e2e.test.ts`
  now expects `Completed` in `route-status`.

## Ambiguities decided

- `unit-render` for a CLI route with `args` does not parse argv (the harness
  treats `args` as provenance only, pre-existing); the test passes `input`
  there. Not in A7's scope to change.
- `Agent.Error` inside a tool invoked via its CLI projection is a
  `process-exit` (exit 1), not `represented-error`: the surface decides.
- The runtime backend's `represented-error` summary is
  `The document reports status <status>.` — it has no node walker and no
  projection; not worth duplicating the service's walker in the browser bundle.
- No new diagnostic code was needed; `AB8252` remains the last allocated.
- The changeset summary was extended in place (`wb600-pr2a-execution-parity.md`).
