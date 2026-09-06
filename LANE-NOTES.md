# Lane S3 — Workbench host sessions (#600 PR 3)

Branch `lane/wb600-pr3-s3`. Consumes the frozen `/api/sessions` HTTP/SSE contract in
`/tmp/wb600/PR3-CONTRACT.md` (incl. the 06:20 `traceSessionId` amendment). No server code.

## Files

New (`packages/workbench/src/sessions/`):

- `host-session-contracts.ts` — browser-safe wire types: `HostSessionHost`, `HostSessionState`,
  `HostSessionAuthority`, `HostSession` (with `traceSessionId?`), `HostAvailability`,
  `HostSessionLaunchRequest`, `HostSessionSize`, `HostSessionList`. **Temporary** — see request 1.
- `host-session-client.ts` — `HostSessionClient` (`list`, `launch`, `read`, `stream`, `input`,
  `resize`, `terminate`, `restart`, `forget`), `HostSessionClientError` (`code`, `status`),
  `HostSessionStreamMessage` (`state` / `output` with decoded `bytes` / `end`), `decodeBase64`.
  Zod strict decoders; every path goes through `ForegroundRequestAuthority.protectedRequest`
  (mutation session, same as `/api/invocations`). Keep-alive comment frames are skipped.
- `host-session-model.ts` — `reduceHostSessions` (`list` / `session` / `forget` / `error`;
  `session` replaces the record by id, so a repeated `state` frame carrying `traceSessionId`
  just lands), `initialHostSessionsState`, `hosts`, `defaultHostSessionSize` (120×32),
  `hostLabel`, `sessionStateLabel`, `availabilityFor`, `hostSessionPromptFor(leaf)`.
- `terminal.tsx` + `terminal.css` — `SessionTerminal`: one xterm per mounted session id; SSE
  `output` → `term.write(bytes)`, `onData` → `POST …/input`, `ResizeObserver` → debounced 100 ms
  `fit.fit()` → `onResize` → `POST …/resize`; `state`/`end` frames → `onSession`. `live=false`
  (exited/terminated) suppresses input/resize posts. xterm's stylesheet is pulled with
  `@import '@xterm/xterm/css/xterm.css'` from `terminal.css` (a bare `import '…/xterm.css'` in
  TSX is externalized by the Rstest pool and fails under Node).
- `sessions-page.tsx` + `sessions-page.css` — `SessionsPage({ client, onNavigate, session? })`:
  left column launch buttons (disabled with the availability `reason`), session list; right
  column toolbar (`Trace` link → `{ area: 'trace', correlation: traceSessionId ?? id }`,
  `Terminate`, `Restart`, `Forget`), terminal, authority strip (project root, epoch, install,
  state + pid/exit/signal, restartOf, host session id).
- `open-in-host.tsx` — `OpenInHost({ client, leaf, onNavigate })`: `Open in Claude` /
  `Open in Codex` beside Run; `GET /api/sessions` on mount for availability; `POST /api/sessions`
  with the contract prompt, then navigates to `{ area: 'sessions', session: id }`. Renders
  nothing for leaves without a prompt (resource, prompt, script, skill, command, rule).

Modified:

- `packages/agent-bundle/src/dev/trace/trace-entry.ts` — `traceSources` += `'session'`
  (identical to S1/S2's edit; dedupe on merge).
- `shell/workbench-location.ts` — `sessions` location is `{ area: 'sessions', session?: string }`,
  URL `/sessions?session=<id>`; the unused `/sessions/<host>` form is gone.
- `shell/workbench-shell.tsx` — nav item `Host sessions` (`▣`) between Trace and Problems;
  `Exclude<WorkbenchArea, 'sessions'>` removed.
- `main.tsx` — `HostSessionClient` in the shared client set and in `WorkspaceClients`;
  `case 'sessions'` renders `SessionsPage`.
- `application/workspace-contracts.ts` — `WorkspaceClients.hostSessionClient`.
- `application/route-input-editor.tsx`, `executable-route-workspace.tsx`,
  `event-route-workspace.tsx`, `route-workspace.tsx` — optional `actions` node rendered beside
  Run; `InvokeWorkspace` supplies `<OpenInHost>`.
- `trace/trace-model.ts` — `'session'` in headline priority (top), invocation-level rows, glyph
  `▣`; `traceGroupKeyValue` (moved from the page); `traceGroupSessionLocation(group)` → Sessions
  pane link when the group is keyed by `sessionId` and the value starts with `hs_`. Kind labels
  for `session.attached/exited/terminated`.
- `trace/trace-page.tsx` — group header renders a `Session` link (`data-testid="trace-group-session"`).
- `THIRD_PARTY_NOTICES` — xterm.js + addon-fit (MIT, full text inlined; no extra copied file).
- `tests/support/workbench-acceptance.ts` — `primaryNavLabels` gains `Host sessions`;
  `workbenchTestIds` gains `routeOpenInClaude`, `routeOpenInCodex`, `sessionsAuthority`,
  `sessionsEmpty`, `sessionsForget`, `sessionsItem`, `sessionsLaunchClaude`, `sessionsLaunchCodex`,
  `sessionsList`, `sessionsPlaceholder`, `sessionsRestart`, `sessionsState`, `sessionsTerminal`,
  `sessionsTerminate`, `sessionsTrace`, `traceGroupSession`.

Tests: `host-session-client.test.ts`, `host-session-model.test.ts`, `sessions-page.test.ts`
(static render of the page and `OpenInHost`), plus extended `workbench-location.test.ts`,
`trace-model.test.ts`, `trace-page.test.ts`, `workbench-shell.test.ts`; `workspace-fixtures.ts`
constructs the new client.

## Requests for the integrator

1. Replace the body of `src/sessions/host-session-contracts.ts` with
   `export type { … } from '../../../agent-bundle/src/contracts/host-sessions.ts'` (or point the
   four importers — client, model, terminal, page — at it directly and delete the file) once S1
   lands. Field names/optionality here match the contract exactly; `HostSessionLaunchRequest`,
   `HostSessionSize`, and `HostSessionList` are convenience shapes S1 may or may not export.
2. `traceSources` `'session'`: three lanes append the same literal — keep one.
3. The browser client reports its own failures (malformed id, undecodable response/frame) as
   `AB8261`; the server's diagnostic `code` wins whenever a response carries one. If you prefer a
   dedicated browser-decoder code (the AB8233–AB8235 block), it is one constant in
   `host-session-client.ts`.
4. `Open in <host>` seeds the prompt with `leaf.routeId` verbatim for tools
   (`Call the tool:curator/search_audible tool …`), as the contract text says. If the intended
   spelling is the bare tool name, change one line in `hostSessionPromptFor`.
5. `primaryNavLabels` now has five entries; every e2e that asserts the nav (`expectPrimaryNav`)
   picks it up automatically.
6. Not done here (S4/S2 own them): docs pages, changeset, browser e2e, `dev-server-http.mdx`
   `TraceEntry.source` union.

## Gate

`pnpm build && pnpm typecheck && pnpm lint` green; Workbench unit pool
(`pnpm rstest --config rstest.unit.config.ts packages/workbench/tests`) green — see the report.
