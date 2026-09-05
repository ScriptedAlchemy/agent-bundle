# Lane T5 — Trace page: correlated live timeline

Branch `lane/wb600-pr2-t5` on `wb600-pr2-trace`. Gate green: `pnpm build && npx tsc --project
packages/workbench/tsconfig.json --noEmit && pnpm lint && npx rstest --config rstest.unit.config.ts
packages/workbench/tests/trace-*.test.ts packages/workbench/tests/workbench-location.test.ts
packages/workbench/tests/project-client*.test.ts` (65 tests). Also green alongside:
`dev-server-backend`, `workbench-shell`, `workbench-router` unit tests.

## Files

Added

- `packages/workbench/src/trace/trace-client.ts` — `TraceClient`, `ForegroundTraceClient`, strict decoders,
  `openTraceFeed` (replay → stream → back-off reconnect). Imported by `trace-page.tsx` and `main.tsx`.
- `packages/workbench/src/trace/trace-model.ts` — pure merge / group / filter / select / format helpers.
  Imported by `trace-client.ts` (merge) and `trace-page.tsx`.
- `packages/workbench/src/trace/trace-page.css` — page layout; imported by `trace-page.tsx`.
- `packages/workbench/tests/support/trace-fixtures.ts` — `traceEntry(sequence, overrides)` and
  `sampleTraceEntries` (the brief's example timeline: one Claude session with hook/kernel/mcp rows, a lone
  invocation, a failed runtime run, a lone log line). Shared by the three trace tests.
- `packages/workbench/tests/trace-client.test.ts`, `packages/workbench/tests/trace-model.test.ts`.

Changed

- `packages/workbench/src/trace/trace-page.tsx` — rewritten. The PR 1 stopgap (`loadTraceHistory`,
  `mergeTraceEntries` over `/api/routes/invocations`, `sortTraceEntries`, `traceDurationMs`,
  `traceEntryLocation`, the `.trace-table` markup) is gone; the page reads `/api/trace` only.
- `packages/workbench/src/main.tsx` — constructs `new ForegroundTraceClient({ foreground })` in
  `createClients` and renders `<TracePage client correlation entryId onNavigate />`. The Trace case no
  longer waits for the application tree (it does not need it).
- `packages/workbench/src/shell/workbench-location.ts` — `/trace/<entryId>` and `/trace?correlation=<id>`
  parse and format; `WorkbenchLocation['trace']` gains `correlation?: string`. `invocationId` stays as the
  field name for the selected entry (the shell and PR 1 tests read it); the doc comment says so.
- `packages/workbench/src/project-client.ts` — `'route.invocation'` added to `projectEventTypes` (the
  inventory §2 latent bug: the browser subscribed to the event but the allowlist dropped it). Activity
  events (`route.invocation`, `runtime.event`) no longer trigger a `/api/status` refetch — they never change
  project status, and a hot invocation loop would otherwise hammer the status route.
- `packages/workbench/tests/trace-page.test.ts`, `workbench-location.test.ts`, `project-client.test.ts` —
  new cases; every pre-existing case still passes.
- `docs/diagnostics.md` — `AB8249` registered (see below).

## Exported API (for T6 and the integrator)

`packages/workbench/src/trace/trace-client.ts`

```ts
export interface TraceClient {
  replay(after?: number): Promise<TraceReplay>;
  stream(after: number | undefined, onMessage: (message: TraceMessage) => void, signal: AbortSignal): Promise<void>;
}
export class ForegroundTraceClient implements TraceClient { constructor(options: { foreground: ForegroundRequestAuthority }) }
export class TraceClientError extends Error { readonly code: string }
export const TRACE_INVALID_RESPONSE_CODE = 'AB8249';
export const decodeTraceEntry: (value: unknown) => TraceEntry;      // throws TraceClientError(AB8249)
export const decodeTraceMessage: (value: unknown) => TraceMessage;  // entry | gap frame
export const decodeTraceReplay: (value: unknown, after: number) => TraceReplay;
export interface TraceFeedState { connected; entries; error?; gap?; loaded }
export const openTraceFeed: (options: { client; onState; retryDelay? }) => { close(): void };
```

`TraceReplay` is `{ entries, latestSequence, gap? }` — the shape of `GET /api/trace?after=` per the brief.
Decoder bounds: 64 KiB per NDJSON frame; `summary` ≤ 240 chars; `kind` ≤ 128, identifier grammar, must contain
a `.`; `details` is any JSON whose strings pass the safe-text rule (no control characters, no credential-shaped
tokens via `redactEvalCredentialText`, no absolute/Windows/UNC path or `file:` URL) and whose keys are not
credential keys; `href` must be a shell path (`/routes/…`, `/trace…`, `/problems`, `/advanced/…`, same origin,
no hash); `source` must be one of the seven `TraceSource` values (unknown → `AB8249`, not a crash); `status` ∈
`ok|error|running`; `id` and every correlation value are identifiers `^[A-Za-z0-9_][A-Za-z0-9._:@+/-]*$` ≤ 256
chars (route ids like `tool:curator/search` pass); `occurredAt` must round-trip through `toISOString()`;
`sequence ≥ 1`. Replay entries must be contiguous from `after` (or from `gap.firstAvailableSequence - 1`),
`gap.requestedAfterSequence` must equal `after`, and `latestSequence` must equal the last entry's sequence
(or `after` when empty, or `gap.firstAvailableSequence - 1` for an empty gap) — anything else is `AB8249`.

Reconnect: replay once, then stream from the last delivered sequence; on stream end or failure back off
250 ms doubling to 5 s and replay again from the cursor. A refused replay from a non-zero cursor
(`TRACE_CURSOR_AHEAD` after a dev-server restart) restarts from `after = 0`. Retention in the browser is
`maximumTraceEntries = 4096` (matches the hub's default cap); a server `gap` frame is surfaced in the page.

`packages/workbench/src/trace/trace-model.ts`

```ts
export const mergeTraceEntries: (existing, incoming) => readonly TraceEntry[];   // by sequence, bounded
export const groupTraceEntries: (entries) => readonly TraceGroup[];
export const filterTraceGroups: (groups, filter: TraceFilter) => readonly TraceGroup[];
export const matchesTraceFilter, isEmptyTraceFilter, traceFacetsFor;
export const selectTraceGroup: (groups, id) => TraceGroup | undefined;   // ?correlation=<id>
export const selectTraceEntry: (entries, id) => TraceEntry | undefined;  // /trace/<id>; also a PR 1 inv_… id
export const formatTraceTime (HH:MM:SS.mmm), formatTraceDuration, traceSourceGlyph, traceKindLabel;
export interface TraceGroup { key; keyKind; headline; rows: TraceRow[]; startedAt; endedAt; spanMs; status; firstSequence; lastSequence }
```

Grouping is a union-find over the join keys `conversationId → sessionId → invocationId | executionId | runId |
mcpSessionId:mcpRequestId → correlationId`; a group's `key`/`keyKind` is the strongest key it shares, else
`entry:<id>` for a singleton. `mcpRequestId` alone never joins (request ids repeat across sessions). Facets
(`host`, `routeId`, `epochId`) never join. Within a group, `invocation`/`hook`/`diagnostic` rows sit at depth 0
and `kernel`/`mcp`/`log`/`runtime` rows at depth 1. Headline priority: invocation > hook > runtime > mcp >
kernel > diagnostic > log, earliest wins ties. Group status: `error` if any row errors, `running` if the
last row is running, else `ok`. Filters are applied to rows *after* grouping, so a filter never re-keys a group.

`packages/workbench/src/trace/trace-page.tsx`

```ts
export interface TracePageProps { client: TraceClient; correlation?: string; entries?: readonly TraceEntry[]; entryId?: string; onNavigate; timeZone?: string }
export const TracePage: (props: TracePageProps) => JSX.Element;
```

`entries` is a supplied snapshot for static/server rendering and tests (the live feed is not opened).
Row markup: `[data-testid="trace-entry"][data-entry-id][data-kind][data-source][data-status]` inside
`[data-testid="trace-group"][data-group-key]`; also `trace-timeline`, `trace-filter-bar`, `trace-detail`,
`trace-new-pill`, `trace-empty`. Clicking a row pushes `/trace/<entry.id>` (keeps `?correlation=`).

`packages/workbench/src/shell/workbench-location.ts`

```ts
| Readonly<{ readonly area: 'trace'; readonly correlation?: string; readonly invocationId?: string }>
```

`/trace/trc_5?correlation=conv-1` ⇄ `{ area: 'trace', correlation: 'conv-1', invocationId: 'trc_5' }`.

## Cross-lane requests (exact edits for the integrator)

1. **`packages/workbench/src/shell/shell.css` lines 167–178** (PR 1 trace rules, now dead):

   ```css
   .problem-list, .trace-table { min-width: 0; }
   ...
   .problem-link, .trace-link { color: #0759c7; ... }
   .problem-link:hover, .trace-link:hover { text-decoration: underline; }
   .trace-status { ... } .trace-status--succeeded { ... } .trace-status--failed { ... }
   .trace-entry { ... } .trace-entry dl { ... } .trace-entry dt { ... } .trace-entry dd { ... }
   ```

   Drop `.trace-table` and `.trace-link` from the shared selectors (keep `.problem-list`, `.problem-link`)
   and delete the `.trace-status*` and `.trace-entry*` rules. My rows use `.trace-line`, so nothing collides
   today; this is delete-on-sight.

2. **`packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts` lines 110–119** — the PR 1 trace
   step reads `.trace-table tr[data-invocation-id]`. Once T1 (`/api/trace`) and T2 (invocation → trace
   entries) land, replace with:

   ```ts
   await openWorkbench(page, server.url, `/trace?correlation=${encodeURIComponent(invocationId)}`);
   await expect(page.getByRole('heading', { name: 'Trace', exact: true })).toBeVisible({ timeout: browserTimeout });
   const traceRow = page.locator('[data-testid="trace-entry"][data-kind="invocation.completed"]').first();
   await expect(traceRow).toBeVisible({ timeout: browserTimeout });
   await expect(traceRow).toContainText(searchLeaf.routeId ?? 'tool:curator/search_audible');
   await captureExampleState(page, 'audiobook-curator', 'trace-populated');
   await traceRow.click();
   await waitForWorkbenchIdle(page);
   expect(new URL(page.url()).pathname).toMatch(/^\/trace\/trc_\d+$/u);
   await expect(page.getByTestId('trace-detail')).toBeVisible({ timeout: browserTimeout });
   ```

   `/trace/<invocationId>` still resolves (`selectTraceEntry` falls back to the latest entry carrying that
   `invocationId`), so the old deep link keeps working; only the clicked-row URL changed to the entry id.

3. **`website/docs/en/guide/development/workbench.mdx` line 172 and the `zh` twin** — `/trace/<invocation-id>`
   → `/trace/<entry-id>` plus a line `/trace?correlation=<id>` ("show one correlated group"). Whoever owns the
   docs page for PR 2 should also describe the Trace page: sources, correlated groups, filter bar, detail
   drawer, "Open route".

4. **T1 (`/api/trace` route)** — the client sends `GET /api/trace?after=<n>` and `GET /api/trace/stream?after=<n>`
   through `ForegroundRequestAuthority.protectedRequest` (session header + origin guard, no custom `Accept`),
   and expects the replay body `{ entries, latestSequence, gap? }` and the stream as one `TraceMessage` per
   line — a bare `TraceEntry` object or a bare `TraceReplayGap` (`type: 'trace.gap'`), exactly the contract
   union, no envelope. Stream entries must be contiguous from `after + 1`; a skip is `AB8249` unless a gap
   frame precedes it (`requestedAfterSequence` = last delivered, then entries resume at
   `firstAvailableSequence`). No heartbeat frame is expected; blank lines are ignored, so an empty line is a
   safe keep-alive. If T1 emits a typed heartbeat, tell me the shape and I add it to `decodeTraceMessage`. A
   refusal must be the standard `{ diagnostic: { code: 'ABnnnn', message } }` body; any refusal of a replay from a
   non-zero cursor (the hub's `TRACE_CURSOR_AHEAD` after a dev-server restart) triggers restart-from-zero (the
   retained list is dropped, since the hub that numbered it is gone); a refusal at `after = 0`, or an `AB8249`
   decode failure, is shown in the page (`· reconnecting`) and retried with the back-off.

5. **Server-side `source` set** — the decoder accepts exactly the seven `TraceSource` values in
   `contracts/trace.ts`. A new source needs a decoder + glyph + kind label in this lane's files, not a
   silent pass-through.

## Open risks

- No jsdom in the unit pool, so `trace-page.test.ts` covers rendering via `renderToStaticMarkup` with supplied
  snapshots (empty state, groups/rows/depth, selected-entry drawer with correlation links and "Open route",
  filter bar, `?correlation=` scoping, error flags). Scroll-anchoring, the "N new" pill, and the live feed
  are exercised only through `openTraceFeed`'s fake-client tests and a manual 1440×900 render check; the
  browser acceptance of the live behaviour belongs to the integration e2e once T1/T2 land.
- `entryId` still travels as `WorkbenchLocation.invocationId` — renaming it touches the shell and PR 1 tests
  outside this lane. Cheap follow-up if the integrator wants it.
- `ProjectClient` now forwards `route.invocation` to subscribers; nothing in the Workbench consumes it yet
  (the Trace page reads `/api/trace`, not project events). It exists so T6/T7 can react without another
  allowlist bug, and the test pins that it does not trigger a status refetch.

## Proposed changeset line (agent-bundle only; Workbench is private)

None from this lane — every change is under `packages/workbench` plus `docs/diagnostics.md`. If the
integrator wants the diagnostics registry mentioned, append to the PR's single changeset:
"… the Workbench Trace page's browser decoder rejects a malformed `/api/trace` reply with `AB8249`."

## Proposed diagnostic codes

- `AB8249` — Workbench browser-side strict decoder rejecting a `/api/trace` replay or stream frame. Registered
  in `docs/diagnostics.md` (Workbench family table). `AB8240`–`AB8248` left for the server-side trace route (T1).
