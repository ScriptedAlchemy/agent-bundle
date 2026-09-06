# Lane B2 notes

Browser acceptance uses the existing
`accepts the audiobook-curator Application workspace at 1440×900` test in
`packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts`.

## Acceptance criteria

1. **Live progress** — lines 100–121. The copied audiobook fixture gets a
   deterministic 1.5 second analysis delay; the test observes the running
   badge, cancel button, busy non-empty shell document, and a running
   `invocation.started` Trace row before the final succeeded status.
2. **Cancel** — lines 123–142. The test cancels a second live audit, observes
   the cancelled badge and no outcome, finds `invocation.cancelled`, and reads
   the invocation API to prove `status === "cancelled"` with no `outcome`.
3. **Bounded retained output** —
   `packages/agent-bundle/tests/route-invocation-service.test.ts:478–513`,
   `retains only the newest 256 render events and one truncation marker`.
   It proves 300 events become the newest 256, the first retained sequence is
   44, exactly one `{ type: "truncated", dropped: 44 }` is sent, and the final
   invocation still contains the complete document.
4. **Final envelope** —
   `packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts:180–215`.
   The test reads the final invocation API and compares its status, outcome,
   first provider name/status, and first timing phase/duration with the
   workspace status/outcome and Providers/Timings tabs.
5. **Deep links** — lines 230–291. The route invocation deep link survives a
   reload with status, outcome, and correlation; the Trace entry opens its
   detail, which survives reload with the same entry/correlation; its Open
   route link returns to the same invocation and that workspace snapshot also
   survives reload.
6. **Correlation** — lines 297–355, with the cross-source grouping regression
   at `packages/workbench/tests/trace-model.test.ts:76–99`. A real
   `tools/call search_audible` from the MCP session workspace and an
   authenticated hook receipt carrying that session id render in one scoped
   Trace group. `mcpSessionId` is now a session join key, so this does not
   depend on test-only request rewriting.

## Deleted surface

- Removed the Trace filter bar: source chips, host/route/status/text controls,
  Clear action, filter state, facets, filter model exports, CSS, and their
  tests. No acceptance criterion or existing browser test used them.
- Removed the unasserted “N new” scroll pill and its scroll bookkeeping, CSS,
  and test-id assertion.
- Removed the unused `renderedDocumentProgress` acceptance helper key; live
  progress is asserted against the real busy rendered document.
- Removed the matching filter sentence from both English and Chinese
  Workbench documentation.

Pre-deletion `git grep -l` scopes were limited to the feature and its own
tests/styles:

- `trace-filter-bar`: `trace-page.tsx`, `trace-page.css`,
  `trace-page.test.ts`.
- `filterTraceGroups` / `traceFacetsFor`: `trace-model.ts`,
  `trace-page.tsx`, `trace-model.test.ts`.
- `trace-new-pill`: `trace-page.tsx`, `trace-page.css`,
  `trace-page.test.ts`.
- `renderedDocumentProgress`:
  `tests/support/workbench-acceptance.ts`.

Post-deletion:

```text
git grep -l 'trace-filter-bar' -- ':!repos'          # no output
git grep -l 'trace-new-pill' -- ':!repos'            # no output
git grep -l 'renderedDocumentProgress' -- ':!repos'  # no output
```

No Trace source or server endpoint was deleted. Invocation, kernel, MCP, and
hook sources are required by criteria 1, 2, 5, and 6. Runtime, log, and
diagnostic entries remain covered by the existing Trace model/page and
publisher tests. `/api/trace` and `/api/trace/stream` are production callers
of the Trace client; `/api/trace/receipts` is required by criterion 6.

## Gates

- `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit` — pass:
  4,352 passed, 6 skipped.
- `pnpm test:route-unit` — pass: 89 passed.
- Focused prebuilt integration/browser command with
  `route-invocation-dev-server.test.ts` and
  `audiobook-curator.acceptance.e2e.test.ts` (plus the touched Trace unit
  paths) — pass: 4 passed.
- `pnpm docs:site:build` — pass: language parity; 0 broken links across
  28,277 anchors.
- `git diff --check` — pass.

## Open concerns

None. The browser acceptance takes about 105 seconds on the loaded test host
but remains below its 240 second scaled timeout.
