# Lane A8 notes

## Fixture to test map

1. **Preflight outcomes** —
   `packages/agent-bundle/tests/route-invocation-dev-server.test.ts`,
   `invokes compiled tool and event routes through the foreground server`.
   The `continue` and `deny` handlers would write distinct markers if reached;
   both markers remain absent. The deferred execution path records one gate
   marker and one handler marker, and the handler reports the selected
   `clock` provider plus the framework `processLifetime` provider.
2. **CLI projection parity** — the same dev-server test. The projected
   `report` command renames `service` to `--name`, derives `source` in
   `mapInput`, rejects an unconfirmed Workbench run with the same confirmation
   message and exit behavior as the generated bin, and produces the same
   canonical result after `--yes`.
3. **Byte-for-byte document parity** — the same dev-server test, supported by
   `packages/agent-bundle/tests/route-unit/route-module-loader.test.ts`,
   `resolves a .js import whose source is a .tsx component and renders the module`
   and `leaves a string literal outside a module specifier alone`. The compiled
   route combines a compiler alias, a defined constant, `./panel.js` importing
   `panel.tsx`, and the literal text `./panel.js`.
4. **State across republish** — the same dev-server test. Its first two
   production calls return counts 1 and 2, a successful republish changes the
   epoch, and the next production call returns 3 from
   `<project>/.agent-bundle/state`; explicit `unit-render` calls return 1
   before and after the republish.
5. **Queued source change and cancellation** —
   `packages/agent-bundle/tests/route-invocation-service.test.ts`,
   `rejects a queued invocation when the published revision moves before the slot is acquired`
   asserts the admitted old invocation's `old output` and rejects the queued
   revision with `AB8239`; `does not spawn a child for an invocation aborted
   while queued` asserts one child start total and no queued-child marker.
6. **Browser outcomes and observations** —
   `packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts`,
   `accepts the audiobook-curator Application workspace at 1440×900`. A real
   invalid audiobook fixture makes the inventory tool show a represented
   error, the standalone inventory CLI show exit code 1, and an invalid CLI
   invocation show the manifest `library` provider as `unobserved` with no
   duration. Every assertion waits for the Workbench loading state to clear.

## Byte-for-byte representation

The comparison uses the projected MCP `CallToolResult`: the Workbench
invocation's `projection.mcp` versus `Client.callTool()` against the active
epoch's generated MCP server over stdio. Both values are serialized with the
repository's canonical `stableJson`; the resulting strings are compared
exactly. This representation exercises the generated executable and avoids
mistaking JavaScript object insertion order for a document-byte difference.

## Production fix

The cancelled-while-queued fixture exposed a real gap: route invocation
admission did not receive the HTTP request's abort signal. The minimal fix
makes the semaphore remove aborted waiters before admission, forwards request
and service-close cancellation into admitted work, and connects response
closure to `RouteInvocationService.invoke`. No child is spawned for a request
cancelled while queued. No public API, docs, or changeset update was needed.

## Gate results

- `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit` — pass
  (276 files, 4,158 passed, 6 skipped).
- `pnpm exec rstest --config rstest.route-unit.config.ts` — pass
  (10 files, 89 tests).
- Dev-server integration file with the documented prebuilt environment — pass
  (2 tests).
- Audiobook Curator browser acceptance at 1440×900 with the documented
  prebuilt environment — pass (1 test).
- IDE lint diagnostics and `git diff --check` — clean.

## Open concerns

None.
