# Lane A10 — PR #643 self-review fixes

## Findings

1. **Canonical event preflight bypass** — projected compiled preflight metadata into the route
   manifest/application leaf; reject a preflight route's hostless event surface with HTTP 400
   `AB8255`; disable Canonical in the Workbench and select the first lifecycle target. Covered by
   route-service, application-tree, Workbench workspace, and foreground-server integration tests.
2. **Cancelled while queued** — `RouteInvocationService.invoke` accepts an `AbortSignal`; the HTTP
   route links request/response closure; the semaphore callback checks cancellation before leasing
   and again before execution. The queue regression proves one lease and one child execution.
3. **Fabricated render timing** — made `renderDurationMs` optional, omit the timing when absent,
   and return no observations for preflight short-circuits. Unit and integration assertions cover
   the missing render row and unobserved provider behavior.
4. **MCP input validation** — the epoch Flight worker parses MCP input with the compiled route
   schema before composing the route; validation failures render an MCP error document, producing
   `represented-error` without invoking the handler. Integration verifies invalid input, `isError`,
   represented outcome, and no handler marker.
5. **`import.meta.main` fallback** — generated CLI bins fall back to comparing real
   `process.argv[1]` and `import.meta.url`, using only Node built-ins. Template assertions and both
   affected hashes were regenerated.
6. **Operator `.env` parity** — production invocation composes a detached worker environment once
   with `applyOperatorEnv`; MCP and CLI surfaces now observe the same operator value. Integration
   covers both surfaces.
7. **Duplicated epoch formula** — route invocation imports and uses
   `generatedRouteArtifactEpoch`.
8. **Lease leak window** — the prepared test manifest is constructed before acquiring the epoch
   reference, so a construction throw cannot leak a lease.
9. **Provenance mislabel** — request provenance derives invocation kind from the route kind,
   including unit-rendered event routes. Unit regression included.
10. **Runtime backend outcome invariant** — succeeded runtime runs without document events emit
    `{ kind: "success" }`. Workbench unit regression included.
11. **Docs** — English and Chinese Workbench docs now describe provider omission/unobserved states
    accurately and document `AB8255`; runtime-environment docs limit state-root pinning to the
    Workbench MCP session and invocation workers launched by `agent-bundle dev`.

## Diagnostic allocation

- `AB8255`: an event route with compiled preflight was submitted without a concrete host surface.

## Verification

- `pnpm build` — pass.
- `pnpm typecheck` — pass.
- `pnpm lint` — pass.
- `pnpm test:unit` — pass.
- `pnpm exec rstest --config rstest.route-unit.config.ts` — pass.
- Touched route-invocation integration file with both prebuilt flags — pass.
- `pnpm docs:site:build` — pass.
- `git diff --check` — pass.

## Dismissals and open concerns

- No reviewer finding was dismissed.
- TraceDecay MCP discovery and the CLI daemon socket were unavailable; review used the exact
  reviewer-named files and the full local diff.
