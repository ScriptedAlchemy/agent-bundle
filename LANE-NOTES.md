# Lane W3 — Workbench browser acceptance (PR 2 round 2)

Branch `lane/wb600-pr2-w3` on `wb600-pr2-trace`. No product files under
`packages/workbench/src/trace/**` needed a fix. Workbench is private: no
changeset.

## Files

- `packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts` — replaced
  the PR 1 `.trace-table` step with the T5 URL/markup model.
- `packages/workbench/tests/support/workbench-acceptance.ts` — `traceEntry`,
  `traceGroup`, `traceDetail` test ids; `readCorrelationId`;
  `expectToolInvocationTraceGroup`; `invokeRouteFromWorkbench`.
- `packages/workbench/tests/support/example-acceptance.ts` — leaving Trace
  aborts `GET /api/trace` and `/api/trace/stream` the same way Logs aborts
  its replay/stream; those `net::ERR_ABORTED` rows are allowed.
- `packages/workbench/tests/support/packed-outage-ledger.ts` +
  `packed-outage-ledger.test.ts` — `/api/trace/stream` is a known live stream;
  `/api/trace` replay aborts match the Logs replay contract; post-recovery
  unknown-failure filter claims those client cancellations.
- `packages/workbench/tests/packed-release.e2e.test.ts` — every remaining
  `getByRole('heading', { name: '…' })` is `exact: true` or a `^…$` regex.
  Confirmed: no `Skills` heading assertion remains (PR 1 cut that page).
- `packages/workbench/tests/lifecycles.e2e.test.ts` — Canonical → host mapping
  now prints `claude · receipt` and
  `lifecycle-observed · depth 0 · native · receipt` (not `derived` /
  `no-shared-runtime`).
- `packages/workbench/tests/examples-real.e2e.test.ts` — no old `.trace-table`
  markup; unchanged.

## What each e2e now proves

`audiobook-curator.acceptance.e2e.test.ts` at 1440×900, never while
`workbench-loading` is visible:

1. A Run of `tool:curator/search_audible` populates `/trace`: a
   `[data-testid="trace-group"]` keyed by that invocation holds
   `invocation.started` + `invocation.completed`. Tool routes do **not**
   publish `kernel.*` (`EventTraceEvent` is event-route only); the completed
   row carries `durationMs` (shown as e.g. `2.80 s`). Route identity is on
   the Route facet (`tool:curator/search_audible`) and in the detail drawer —
   summaries arrive as `[REDACTED]` (see W1 request below). Capture
   `trace-populated`.
2. `/trace?correlation=<browser-minted correlationId>` scopes to that one
   group (`Correlated by …`, one `trace-group`).
3. Clicking the completed row pushes `/trace/trc_<n>` and opens
   `trace-detail` with the route id.
4. Cold `page.goto` of that same `/trace/<entryId>` restores the detail
   (`data-entry-id`) after replay.
5. Detail **Open route** goes to
   `/routes/mcp/curator/tool/search_audible?invocation=<id>` and the workspace
   shows that invocation (`route-status--succeeded`, same id, rendered
   document).
6. With `/trace` open, `POST /api/routes/invocations` from the page (session
   bootstrap + `x-agent-bundle-session`) adds a new completed row without
   reload.
7. Existing stale-diagnostic + repair (`problemsBanner`, `problems-stale`,
   `problems-repaired`) still passes.

`packed-release.e2e.test.ts`: heading matches cannot collide with a prefix
or suffix label. Leaving Trace during the desktop navigation floor no longer
fails the outage ledger.

`lifecycles.e2e.test.ts`: request-context copy matches the current workspace
provenance labels.

`logs-real`, `mcp-tasks`, `mcp-session-timeout`, `examples-real`: green
without markup changes. `logs-real` still accepts "Open in Trace" links
(body must not contain the project root or `fixture-secret`).

## Cross-lane requests (exact edits)

### W1 — TraceHub summaries of tool/event identities are `[REDACTED]`

**Failing product behavior (asserted around):** after a successful
`tool:curator/search_audible` run, `/trace` shows

```text
▶ invocation started    [REDACTED]
▶ invocation completed  [REDACTED]   2.80 s
```

The Route facet still lists `tool:curator/search_audible`. The published
summary is `MCP tool curator/search_audible · <duration>` (see
`route-invocation-service.ts` `routeLabel` + `durationText`).

**Cause:** `TraceHub.#summaryFor` runs every summary through `sanitizeText` →
`safeDevWireText` → `redactAbsolutePaths`
(`packages/agent-bundle/src/dev/logs/dev-log-service.ts` ~197–203). After
stripping `<project>/…` prefixes, `hasControlOrSeparators` is true for any
remaining `/` (`0x2f`) and the **entire** string becomes `[REDACTED]`.
`curator/search_audible` and `tool/before` are route/event identities, not
absolute paths.

**Requested edit** in `redactAbsolutePaths` (or a TraceHub-only sanitizer):

Do not treat a leftover relative `word/word` as a path leak. Keep the
existing credential + project-root + `file:` / drive-letter / UNC redaction.
A summary that contains only a single slash between identifier segments must
be published verbatim.

Suggested replacement for the leftover-slash branch (~197–203): drop the
`hasControlOrSeparators(withoutProjectPaths)` disjunct, or restrict it to
strings that still match an absolute POSIX path (`/(?:\/[^\s/]+){2,}/`),
`file:`, a drive letter, or UNC — the same grammar `trace-client.ts`
`pathLikeText` already uses. Do **not** change `hasControlOrSeparators` for
log *context keys* (those must stay slash-free).

Kernel summaries (`event tool/before (claude) · …`) will stay `[REDACTED]`
for the same reason until this lands; tool routes did not emit `kernel.*`
rows in this acceptance run.

### W2 — no edit required from this lane

Provenance label change (`derived` → `receipt`) is already on the branch;
this lane updated `lifecycles.e2e.test.ts` to match.

## Browser pool (one file at a time)

All of these were `pnpm build` (or `AGENT_BUNDLE_WORKBENCH_PREBUILT=1` after
a fresh build) + `npx rstest --config rstest.integration.config.ts <file>`
except packed-release (`pnpm test:packed <file>`).

| File | Result |
|---|---|
| `audiobook-curator.acceptance.e2e.test.ts` | pass (after stream-abort allowlist) |
| `logs-real.e2e.test.ts` | pass first try |
| `mcp-session-timeout.e2e.test.ts` | pass first try |
| `mcp-tasks.e2e.test.ts` | pass first try |
| `lifecycles.e2e.test.ts` | fail then pass (label update) |
| `examples-real.e2e.test.ts` | pass first try |
| `contributor-hmr.e2e.test.ts` | pass |
| `discovery.e2e.test.ts` | pass |
| `evals-real.e2e.test.ts` | pass |
| `host-adoption.e2e.test.ts` | pass |
| `overview.e2e.test.ts` | pass |
| `web-command.e2e.test.ts` | pass |
| `mcp-app-real.e2e.test.ts` | pass |
| `mcp-app-preview-browser.test.ts` | pass |
| `mcp-page-app-browser.test.ts` | pass |
| `evals-compare-client-scope-browser.test.ts` | pass |
| `workbench-surface-dev-server.test.ts` | pass |
| `packed-release.e2e.test.ts` | **fail then pass** (see below) |

`packed-release` first run (`pnpm test:packed -- <file>` accidentally ran the
whole packed include, 12 files): failed at phase `desktop navigation floor`
with

```text
unknown post-recovery failure: GET /api/trace/stream?after=29 net::ERR_ABORTED (HTTP 200)
```

Cause: leaving `/trace` aborts the NDJSON feed; the ledger did not classify
`/api/trace/stream` as a known stream. After the ledger + heading `exact`
fixes, `pnpm test:packed packages/workbench/tests/packed-release.e2e.test.ts`
passed (1 file, 27 s tests).

No flake on the acceptance file after the stream allowlist; no second run
needed there.

## Acceptance captures

Saved under `/tmp/wb600/acceptance-pr2/` (`AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR`).
Acceptance-owned (this lane's required states):

- `/tmp/wb600/acceptance-pr2/audiobook-curator-application-populated.png`
- `/tmp/wb600/acceptance-pr2/audiobook-curator-tool-rendered.png`
- `/tmp/wb600/acceptance-pr2/audiobook-curator-trace-populated.png`
- `/tmp/wb600/acceptance-pr2/audiobook-curator-problems-stale.png`
- `/tmp/wb600/acceptance-pr2/audiobook-curator-problems-repaired.png`
- `/tmp/wb600/acceptance-pr2/audiobook-curator-advanced-evals.png`

`examples-real.e2e.test.ts` wrote additional example captures into the same
directory (and overwrote `report.json` with its own list).

## Open risks

- Until W1 stops redacting `word/word` summaries, screenshot review of
  `trace-populated` shows `[REDACTED]` instead of the route identity. The
  test still pins the Route facet, group membership, kinds, duration, deep
  link, Open route, and live update.
- Tool routes did not emit `kernel.*` in this run. If W1 later forwards
  render-child kernel events for tools, the helper already accepts them.
- `pnpm test:packed -- <file>` passes a literal `--` through to rstest and
  runs the whole packed include; omit `--`.

## Proposed changeset line

None — Workbench-only.

## Proposed diagnostic codes

None.
