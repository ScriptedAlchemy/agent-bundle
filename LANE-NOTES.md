# Lane A5 notes

## Behavior

- Workbench production invocation workers now receive
  `AGENT_BUNDLE_PLUGIN_ROOT=<project>/.agent-bundle/epochs/<epochId>` and
  `AGENT_BUNDLE_STATE_ROOT=<project>/.agent-bundle/epochs/<epochId>/state`.
  The state root is derived from the leased epoch root, shared with that
  epoch's dev MCP sessions, and never derived from the code root.
- Generated CLI parity tests use the same code-root and state-root environment
  as Workbench production invocations.
- Event wrapper source-order assertions cover validation, canonical props,
  preflight, projection, the execute gate, and the Worker boundary in their
  refactored functions. Generated entry hashes and structural assertions match
  the current templates.
- The production invocation error type lives in a dependency-free leaf module.
  This prevents ordinary packed CLI builds from eagerly loading the optional
  `@agent-bundle/runtime` peer while preserving one error-class identity.
- English and Chinese Workbench documentation describe epoch-local persistent
  state and `AGENT_BUNDLE_STATE_ROOT`.

## Files

- `.changeset/wb600-pr2a-execution-parity.md`
- `packages/agent-bundle/src/dev/epoch-paths.ts`
- `packages/agent-bundle/src/dev/mcp-session/mcp-session-launch.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation-child.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation-production-error.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation-production.ts`
- `packages/agent-bundle/src/dev/routes/route-invocation-service.ts`
- `packages/agent-bundle/src/dev/routes/route-module-loader.ts`
- `packages/agent-bundle/src/dev/workbench-server.ts`
- `packages/agent-bundle/tests/entry-shell.test.ts`
- `packages/agent-bundle/tests/route-invocation-dev-server.test.ts`
- `packages/agent-bundle/tests/route-invocation-service.test.ts`
- `packages/agent-bundle/tests/route-unit/route-module-loader.test.ts`
- `packages/agent-bundle/tests/target-hook-contract.test.ts`
- `website/docs/en/guide/development/workbench.mdx`
- `website/docs/zh/guide/development/workbench.mdx`

## Deslop

Deslop: GPT-5.6 Sol, 11 edits.

The pass standardized the prepared-project supplier on an async lease,
replaced structural error sniffing with the single production error class,
normalized the invocation body, tightened cross-process error reconstruction,
removed five restating comments, and condensed the changeset summary.

## Verification

- `pnpm build && npx tsc --noEmit && npx tsc --project packages/workbench/tsconfig.json --noEmit && pnpm lint`
- `pnpm test:unit` — 4,140 passed, 6 skipped
- `npx rstest --config rstest.route-unit.config.ts` — 89 passed
- `npx rstest --config rstest.projection.config.ts` — 190 passed
- `pnpm test:integration:run` — 1,150 passed, 4 skipped
- `pnpm docs:site:build` — locale parity passed and 0 broken links across
  27,307 anchors
- `git diff --check`

The first integration run exposed the packed CLI's eager import of the optional
runtime peer. After moving the production error type to a leaf module, the
focused packed-consumer regression and the complete integration pool passed.

## Open risks

None known. The build and test logs retain pre-existing Rslib top-level-await,
Node SQLite experimental, and occasional test-process listener warnings.
