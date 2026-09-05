# W5 — trace signal quality

## Files changed

- `packages/agent-bundle/src/dev/logs/dev-log-service.ts`
- `packages/agent-bundle/src/dev/hooks/hook-receipts.ts`
- `packages/agent-bundle/tests/dev-log-service.test.ts`
- `packages/agent-bundle/tests/hook-receipts.test.ts`
- `packages/agent-bundle/tests/hook-receipt-pipe.test.ts`
- `packages/workbench/tests/support/workbench-acceptance.ts`

## Behavior

- `safeDevWireText` preserves slash-bearing relative route and event identities such as
  `curator/search_audible`, `tool/before`, `tool:curator/search_audible`, and
  `event:session/start`.
- Control characters, credentials, project roots, `file:` URLs, drive-letter paths,
  UNC paths, home-relative paths, and absolute POSIX paths remain redacted. A project
  path still becomes `<project>/…`.
- Dev Log context identifiers keep their existing slash-free policy except for the
  existing validated `routeId` rule.
- Dev Logs reach Trace only at warning/error level or with a request-scoped join key.
  Epoch, build, route, and target facets alone no longer publish.
- Project-event mirrors already lowered by route invocation, runtime, or project
  diagnostic producers do not publish a duplicate log entry.
- Hook receipt summaries use the canonical `tool/before` event identity.
- Audiobook acceptance requires exactly `invocation.started` and
  `invocation.completed`, a readable `curator/search_audible` completion summary,
  and no `log.project.*` row.

`packages/workbench/src/trace/trace-client.ts` already uses a `pathLikeText` rule that
permits `curator/search_audible`, `tool/before`, and route identifiers while rejecting
absolute paths. No W2 edit is needed there.

## Cross-lane request → W2

`packages/workbench/src/logs/log-client.ts` still defines `isSafeWireText` with
`hasControlOrSeparators(withoutProjectPaths)`, so the Raw Logs client rejects the
relative slash-bearing strings the corrected server sanitizer now emits. Make its
free-text rule mirror `trace/trace-client.ts` exactly:

1. Add the local `hasControlCharacters` loop and `pathLikeText` expression from
   `trace-client.ts`.
2. In `isSafeWireText`, retain the length and credential checks, then use
   `!hasControlCharacters(value) && !pathLikeText.test(value)` instead of
   `!hasControlOrSeparators(withoutProjectPaths)` and the old file/drive/UNC test.
3. Keep `hasControlOrSeparators` for detail keys and context identifiers; do not
   loosen those generic identifier boundaries. Preserve the existing validated
   handling required for `routeId`.
4. Add LogClient cases proving `MCP tool curator/search_audible · 2.9 s` and
   `event tool/before (claude)` decode while absolute/file/drive/UNC/home paths do
   not.

Until that W2-owned mirror lands, `packages/workbench/tests/logs-real.e2e.test.ts`
reliably times out after navigating away and replaying the now-correct slash-bearing
records (two isolated runs). No W2-owned source file was changed in this lane.

## Verification

- Build, root TypeScript, Workbench TypeScript, and lint: passed.
- Six affected unit files: 52 passed.
- `trace-dev-server`, `route-invocation-dev-server`, `hook-receipt-pipe`, and
  `dev-log-foreground`: 4 passed.
- Audiobook curator acceptance: passed.
- `logs-real.e2e.test.ts`: blocked by the W2 decoder mismatch above; failed twice at
  the second replay-row readiness wait.
- IDE diagnostics and `git diff --check`: clean.
- TraceDecay MCP discovery and CLI fallback were attempted; both were unavailable
  because the installed daemon socket was down, so review used focused native reads.

## Acceptance captures

- `/tmp/wb600/acceptance-pr2b/audiobook-curator-trace-populated.png`
- Other audiobook acceptance captures and report are under
  `/tmp/wb600/acceptance-pr2b/`.

The populated trace shows four entries in two invocation groups. Each group contains
only start/completion rows, both summaries name `curator/search_audible`, and no
artifact or project-log mirror group is present.

## Open risks

- Raw Logs remains unable to decode the widened safe free-text grammar until W2
  applies the exact mirror change above.
- No other open risk found in the six-file lane diff.

## Proposed changeset line

Preserve route and event identities in development trace summaries while removing
duplicate project-event log rows from the correlated timeline. (#600)

## Diagnostic codes

None.
