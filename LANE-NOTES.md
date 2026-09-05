# T8 — English docs for the unified trace

## Files changed

- `website/docs/en/guide/development/workbench.mdx`
- `website/docs/en/guide/development/testing.mdx`
- `website/docs/en/examples/audiobook-curator.mdx`
- `website/docs/en/examples/hooks-and-scripts.mdx`
- `website/docs/en/examples/mcp-app.mdx`
- `website/docs/en/reference/dev-server-http.mdx` (new)
- `website/docs/en/reference/index.mdx`
- `website/docs/en/reference/runtime-environment.mdx`
- `website/docs/en/reference/_meta.json`

No current hand-written architecture page under `docs/*.md` describes the unified Workbench
trace. The matches there are historical plans/specifications or unrelated Effect/TraceDecay
references, so none was changed. `docs/diagnostics.md` remains owned by T1/T7.

## Page and section ledger for the zh lane

Mirror these changes 1:1:

1. **Developer Workbench**
   - Navigation: Trace is the correlated application-activity timeline.
   - Replace **Trace** with the real event-route transcript, producer/kind/correlation/href table,
     transitive grouping order, source/host/route/status/text filters, `?correlation=`,
     `/trace/<entry-id>`, Open route, route-workspace and Raw-log Open in Trace, replay/NDJSON
     routes, host receipt security, and excluded payload/document/environment data.
   - **Advanced → Raw logs**: retained as the complete redacted producer firehose; correlated
     rows link into Trace.
   - **URL model**: add `?correlation=`, generalize `/trace/<entry-id>`.
   - **Route invocation API**: add trace replay, stream, receipt routes and link the HTTP
     reference.
2. **Testing**
   - After `inspectWorkbenchSurface`, add browser acceptance guidance for `trace-timeline`,
     `trace-entry`, `trace-group`, and `trace-detail`, including Open route snapshot verification.
3. **Audiobook Curator**
   - Workbench step 4: open Trace for the invocation start/completion and return with Open route.
4. **Hooks and Scripts**
   - Workbench step 4: follow invocation/kernel activity and attached-host receipts in Trace,
     restore snapshots with Open route, and reserve Raw logs for uncorrelated details.
5. **MCP App**
   - Workbench step 6: after the Protocol invocation, open Trace for MCP
     request/response/notification/session activity.
6. **Development-server HTTP** (new reference page)
   - Route invocation, runtime run, MCP correlation, trace replay/stream, Raw logs, and
     `POST /api/trace/receipts` contracts.
7. **Reference index and navigation**
   - Add Development-server HTTP after Diagnostics.
8. **Runtime environment**
   - Add `AGENT_BUNDLE_DEV_TRACE_URL` and `AGENT_BUNDLE_DEV_TRACE_TOKEN`.

## Source reconciliation

- T1: `GET /api/trace?after=<sequence>`,
  `GET /api/trace/stream?after=<sequence>`, JSON replay plus NDJSON stream, and diagnostics
  `AB8240`–`AB8242`.
- T2: invocation/kernel kinds; optional `requestId` on `RouteInvocationRequest` and summary;
  event-route kernel entries carry `executionId`.
- T3: MCP kinds and `_meta` correlation; `tools/call` accepts top-level `correlationId`; route
  hrefs use `?session=<mcpSessionId>`, with Protocol fallback.
- T4: `DevRuntimeInvocationRequest.correlationId`; retained Raw logs; Open in Trace precedence
  `correlationId`, then `invocationId`, then `mcpSessionId`.
- T5: transitive join keys and priority; source/host/route/status/text filters;
  `?correlation=` group selection; `/trace/<entry-id>` detail and `Open route`; required test ids.
- T6: route workspace Trace tab and `Open in Trace`; runtime requests carry `correlationId`.
- T7: `POST /api/trace/receipts`; 16 KiB strict receipt; random per-dev-server bearer token;
  owner-only endpoint record removed at close; no-Origin plus loopback-peer guard; 750 ms
  best-effort send; payload-free receipt and `hook.*`/`session.*` lowering. T7 owns
  `AB8247`–`AB8249`.

## Exported API

None. Documentation only.

## Cross-lane requests

- Zh lane: mirror the page/section ledger above, including the new page and `_meta.json` entry.
- Integrator: after T1/T7 are merged, confirm generated Diagnostics includes
  `AB8240`–`AB8242` and `AB8247`–`AB8249`; do not hand-edit generated website diagnostics.

## Verification

- Initial `pnpm install --frozen-lockfile --prefer-offline && pnpm build`: passed.
- `pnpm docs:site:build`: typecheck passed, then stopped only at the expected locale drift:
  - `en/guide/development/workbench.mdx`: fenced blocks, heading count, table rows
  - `en/reference/_meta.json`: entry count
  - `en/reference/dev-server-http.mdx`: missing zh twin
  - `en/reference/index.mdx`: table rows
  - `en/reference/runtime-environment.mdx`: table rows
- A parity-skipping diagnostics/build attempt passed diagnostics coverage and rendered every
  page, then Rspress stopped only because `zh/reference/dev-server-http.mdx` is absent.
- The built-link scan checked 27,116 anchors and reported only that expected missing zh page.
- IDE diagnostics: none.

## Changeset and diagnostics

No changeset: documentation only. No diagnostic code is introduced by this lane.
