# S1 — host-session server

## Files

- `packages/agent-bundle/src/contracts/host-sessions.ts`
- `packages/agent-bundle/src/dev/sessions/{pty,host-session-service,host-session-routes}.ts`
- `packages/agent-bundle/src/dev/{foreground-server,workbench-server,host-install-manager}.ts`
- `packages/agent-bundle/src/dev/trace/trace-entry.ts`
- `packages/agent-bundle/{package.json,rslib.config.ts}`
- `packages/agent-bundle/tests/host-session-{service,routes,pty}.test.ts`
- `rstest.integration-tests.ts`
- `docs/diagnostics.md`

## Exported API

- `agent-bundle/contracts/host-sessions` exports `HostSessionHost`, `HostSessionState`,
  `HostSession`, and `HostAvailability`.
- Internal server API: `HostSessionService` (`availability`, `list`, `read`, `create`,
  `input`, `resize`, `terminate`, `restart`, `forget`, `subscribe`, `attach`,
  `traceSessionId`, `close`), `HostSessionRoutes`, and the fakeable `PtyAdapter` /
  `PtyProcess` boundary.
- `DevHostInstallManager.attached(host)` exposes the current installed
  `{ destination, epochId }`.

## Integrator requests

1. S2's receipt option is not present on this branch. After S2 lands, pass
   `attachHostSession: (devSession, hostSessionId) =>
   hostSessions.attach(devSession, hostSessionId)` to `attachHookReceipts(...)`.
   The current declaration of `hookReceipts` precedes `hostSessions`; move that
   declaration below the service construction (the environment callback is lazy)
   or use an equivalent deferred forwarding closure.
2. S2's `HostMcpRoutesOptions.traceSessionId` is not present on this branch.
   After S2 lands, add
   `traceSessionId: (devSession) => hostSessions.traceSessionId(devSession)` to
   the `new HostMcpRoutes(...)` options in `workbench-server.ts`.
3. Both S1 and S2 append `'session'` to `traceSources`; keep one tuple entry
   when merging.
4. S3 should consume `agent-bundle/contracts/host-sessions` and use
   `session.traceSessionId ?? session.id` for Trace links.

## Verification

- `pnpm build`: pass.
- `pnpm lint`: pass.
- `pnpm exec tsc --noEmit`: pass (server/root TypeScript graph).
- Host-session unit files: 9 tests pass.
- `host-session-pty.test.ts` + `dev-workbench.test.ts`: 34 tests pass.
- `pnpm typecheck`: blocked only by S3-owned exhaustive switches after the new
  trace source: `packages/workbench/src/trace/trace-model.ts` lines 96, 116,
  and 266 do not yet handle `'session'`.

## Unfinished by lane ownership

- The two S2 wiring lines above await S2's option declarations.
- S2 owns `AB8266` and runtime-environment documentation; S4 owns the
  Workbench/HTTP guide and the single PR changeset.
- No package dependency was added. The package build accepted the lazy
  `createRequire(... )('@lydell/node-pty')` adapter.
