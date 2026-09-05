# Lane A11 — deslop pass for PR #643

Branch `lane/wb600-pr2a-a11`, based on `18739c3a8d` (PR head, contains `origin/main`).
Behaviour unchanged except the one trivial loader fix called out below.

## Edits: 14 across 12 files

| # | Category | File | Edit |
|---|----------|------|------|
| 1 | changeset | `.changeset/wb600-pr2a-execution-parity.md` | Rewrote as one user-facing paragraph: names `POST /api/routes/invocations`, `agent-bundle dev`, `AGENT_BUNDLE_STATE_ROOT`, the `surface` union, `outcome`, and each of `AB8239`, `AB8250`–`AB8255` with what it means; ends `(#643)`. |
| 2 | dead branch / duplication | `src/dev/routes/route-invocation-production.ts` | Collapsed the duplicated `ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE` throw (missing `bin/` and no matching bin) into one throw after the loop; `bins` is `[]` when `bin/` is absent. |
| 3 | dead branch | `src/dev/routes/route-invocation-service.ts` | Removed `if (admissionSignal.aborted) abort();` — it follows `admissionSignal.throwIfAborted()` synchronously, so it can never be true. |
| 4 | nesting | `src/dev/routes/route-invocation-service.ts` | `renderInChild` error mapping: `Object.assign(new Error(...), { name })` instead of a post-hoc `instanceof` re-check. |
| 5 | stale comment | `src/dev/routes/route-invocation-service.ts` | `stateRoot` doc comment described `<epoch>/state`; state now lives at `devStateRoot` (`<project>/.agent-bundle/state`). |
| 6 | trivial bug fix (see below) | `src/dev/routes/route-module-loader.ts` | `rewriteTsxSpecifiers` now writes `./foo.tsx`, not `./foo.jsx`. |
| 7 | unused export | `src/test/render.ts` | Deleted `parseCliCommandInput`, a one-line alias of `mapGeneratedCliInput` with a comment restating its callee; both call sites import `mapGeneratedCliInput` directly. |
| 8 | unused import | `src/test/cli.ts` | Same alias removal, call site switched. |
| 9 | stale fixture | `tests/route-invocation-service.test.ts` | Fixture paths still spelled `.agent-bundle/epochs/epoch-1/state`; now `.agent-bundle/state`, matching `devStateRoot`. Assertions unchanged. |
| 10 | style | `tests/route-invocation-dev-server.test.ts` | `join(join(a, b), c)` → `join(a, b, c)`. |
| 11 | style | `packages/workbench/src/application/event-route-workspace.tsx` | `eventRequestFor` block body with a lone `return` → expression body. |
| 12 | duplication | `packages/workbench/src/application/route-input-editor.tsx` | Two identical frozen CLI-surface draft literals → `cliSurfaceDraft(command, args)`. |
| 13 | docs | `website/docs/en/guide/development/workbench.mdx` | Inspector sentence said "Providers and timings show **unobserved**"; timings never show that label, they omit unmeasured phases. Reflowed the envelope paragraph whose lines had been left ragged mid-sentence. |
| 14 | docs | `website/docs/zh/guide/development/workbench.mdx` | Same two corrections, keeping zh in step with en. |

Left alone on purpose: the `as never` casts on `JsonValue` in `route-invocation-production.ts`
(same pattern as the existing `route-invocation-child.ts`; no narrower type is available at those
sites), and the `try`/`catch` around leasing in `RouteInvocationService` (it converts a real
failure mode into `AB8235`).

## Suspected bug (fixed, trivial)

`route-module-loader.ts` `rewriteTsxSpecifiers` appended `x` to a `.js` specifier, producing
`./report.jsx` for a file that exists only as `./report.tsx`. It worked because jiti's resolver
falls through to `.tsx` for an unknown `.jsx`, so the rewrite was only ever coincidentally right,
and the guard on the line above (`existsSync(\`${stem}.tsx\`)`) already proved which file is
meant. Now writes `.tsx`. Behaviour observable to users is unchanged; `tests/route-unit/route-module-loader.test.ts`
still passes and asserts the same loaded module.

No other bugs found. The `admissionSignal.aborted` check (edit 3) was dead, not wrong.

## Dead-module check

`git diff origin/main...HEAD --name-status | rg '^A'`, then `git grep -l <stem> -- ':!repos'`:

- `route-invocation-production-error.ts` — 3 hits (child, production, service)
- `route-invocation-production.ts` — imported by `route-invocation-child.ts`
- `route-module-loader.ts` — imported by `route-invocation-child.ts` (+ its route-unit test)
- `state-paths.ts` — imported by `mcp-session-launch.ts` and `workbench-server.ts`

Every added module has a production importer.

## Gate results (all on the final tree)

- `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit` — green (unit: 4242 passed, 0 failed; lint 1425 files).
- `pnpm test:route-unit` — green (89 passed).
- `pnpm docs:site:build` — green (language parity ok, 0 broken links / 28553 anchors).
- `pnpm test:integration:run` — **not green on this host**, and provably not because of this pass.
  Every failure is in `tests/route-invocation-dev-server.test.ts`, whose first test carries a
  hard-coded 60 s timeout and whose second relies on the service's 60 s invocation timeout:
  - edited tree, run 1: 1146 passed / 1 failed (`invokes compiled tool and event routes…`
    timed out at 60 s after 95 assertions);
  - edited tree, run 2: 1145 / 2 (same timeout; plus `enforces compiled preflight…` got a
    non-envelope response, i.e. the invocation itself timed out);
  - edited tree, run 3: 1146 / 1 (same timeout);
  - **untouched PR head `18739c3a8d`, same command: 1145 / 2 — the identical two failures.**
  The host load average was 45–99 throughout (other lanes building on the same 96-core box).
  The file alone passes on both trees (5 of 6 isolated runs on the edited tree, 1 of 1 on the
  head; the one isolated failure was again the 60 s timeout, with pool wall time varying
  72–94 s between otherwise identical runs). Bisecting the three source edits one at a time
  did not change the outcome. Conclusion: a pre-existing, load-sensitive timeout in that test
  file, not a regression from this pass; it should pass on an idle CI runner as it did on the
  PR's own CI. The integrator may want to rerun the pool on an idle machine before merging.
