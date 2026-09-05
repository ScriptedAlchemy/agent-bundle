/**
 * What the workspace pools collect before the lists below subtract from it:
 * `rstest.unit.config.ts` runs this minus every list; `rstest.config.ts` (the
 * whole-workspace run) minus the lists that need their own process shape. A
 * test file this glob does not match (another extension, another directory)
 * runs only if a list names it — rstest-pool-lists.test.ts enforces that.
 */
export const workspaceTestFileGlob = 'packages/**/tests/**/*.test.ts';

/**
 * Test files that run real builds (Rslib/Rsbuild), spawn child processes, or
 * drive a browser. They run through rstest.integration.config.ts: per-test
 * fixtures via `mkdtemp`, servers on ephemeral ports, and only READS of the
 * prebuilt shared artifacts (`packages/{agent-bundle,workbench}/dist`), so
 * the pool can use multiple workers.
 *
 * A new test file belongs here the moment it runs `build()` from src/api or
 * src/build (directly or via tests/support/build.ts), imports
 * tests/support/workbench-e2e.ts, spawns a process, or launches a browser;
 * otherwise it defaults to the unit pool. Files that `npm pack` the package
 * or import packed-release-harness.ts belong in packedTestFiles below.
 */
export const integrationTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/agent-api.test.ts',
  'packages/agent-bundle/tests/api.test.ts',
  'packages/agent-bundle/tests/artifact-cli-bin.test.ts',
  'packages/agent-bundle/tests/artifact-validator.test.ts',
  'packages/agent-bundle/tests/browser-stdio-bridge-spike.test.ts',
  'packages/agent-bundle/tests/build-compose.test.ts',
  'packages/agent-bundle/tests/build-reproducibility.test.ts',
  'packages/agent-bundle/tests/build.test.ts',
  'packages/agent-bundle/tests/claude-plugin-validate-acceptance.test.ts',
  'packages/agent-bundle/tests/cli-routes-build.test.ts',
  'packages/agent-bundle/tests/cli.test.ts',
  'packages/agent-bundle/tests/composite-rules.test.ts',
  'packages/agent-bundle/tests/dev-contract-adoption.test.ts',
  'packages/agent-bundle/tests/dev-artifact-service.test.ts',
  'packages/agent-bundle/tests/dev-host-install.test.ts',
  'packages/agent-bundle/tests/dev-live-host.test.ts',
  'packages/agent-bundle/tests/dev-package-build.test.ts',
  'packages/agent-bundle/tests/dev-workbench.test.ts',
  'packages/agent-bundle/tests/emitted-artifact-effect-surface.test.ts',
  'packages/agent-bundle/tests/eval-claude-harness.test.ts',
  'packages/agent-bundle/tests/eval-cli.test.ts',
  'packages/agent-bundle/tests/eval-fixtures.test.ts',
  'packages/agent-bundle/tests/eval-harness.test.ts',
  'packages/agent-bundle/tests/eval-service.test.ts',
  'packages/agent-bundle/tests/eval-workbench.test.ts',
  'packages/agent-bundle/tests/examples-check-script.test.ts',
  'packages/agent-bundle/tests/examples-contract.test.ts',
  'packages/agent-bundle/tests/generated-route-server.test.ts',
  'packages/agent-bundle/tests/hook-playground-service.test.ts',
  'packages/agent-bundle/tests/hooks.test.ts',
  'packages/agent-bundle/tests/host-adapters.test.ts',
  'packages/agent-bundle/tests/host-discovery-dev-server.test.ts',
  'packages/agent-bundle/tests/host-mcp-proxy.test.ts',
  'packages/agent-bundle/tests/host-install-proof.test.ts',
  'packages/agent-bundle/tests/host-install-session.test.ts',
  'packages/agent-bundle/tests/installer-entry.test.ts',
  'packages/agent-bundle/tests/integration-matrix.test.ts',
  'packages/agent-bundle/tests/layout-build.test.ts',
  'packages/agent-bundle/tests/lifecycle-replay-dev-server.test.ts',
  'packages/agent-bundle/tests/mcp-apps-compile.test.ts',
  'packages/agent-bundle/tests/mcp-probe-dev-server.test.ts',
  'packages/agent-bundle/tests/mcp-session-service.test.ts',
  'packages/agent-bundle/tests/mcp.test.ts',
  'packages/agent-bundle/tests/package-build.test.ts',
  'packages/agent-bundle/tests/path-token-resolver.test.ts',
  'packages/agent-bundle/tests/prebuilt-payload.test.ts',
  'packages/agent-bundle/tests/prepack.test.ts',
  'packages/agent-bundle/tests/provider-typegen.test.ts',
  'packages/agent-bundle/tests/public-api.test.ts',
  'packages/agent-bundle/tests/publint-gate.test.ts',
  'packages/agent-bundle/tests/route-register-typegen.test.ts',
  'packages/agent-bundle/tests/rsc-runtime-topology-script.test.ts',
  'packages/agent-bundle/tests/rstest-meta-consumer.test.ts',
  'packages/agent-bundle/tests/script-playground-service.test.ts',
  'packages/agent-bundle/tests/self-contained-bundler-config.test.ts',
  'packages/agent-bundle/tests/serve-app-command-spawn.test.ts',
  'packages/agent-bundle/tests/serve-app.test.ts',
  'packages/agent-bundle/tests/target-hook-contract.test.ts',
  'packages/agent-bundle/tests/target-mcp-runtime.test.ts',
  'packages/agent-bundle/tests/test-browser-rstest.test.ts',
  'packages/agent-bundle/tests/workbench-surface-dev-server.test.ts',
  'packages/agent-bundle/tests/worktree-proximity-journeys.test.ts',
  'packages/rsc-markdown-stream/tests/react-server.test.ts',
  'packages/rsc-runtime/tests/markdown-content-flight.test.ts',
  'packages/rsc-runtime/tests/notices-sqlite-cross-process.test.ts',
  'packages/rsc-runtime/tests/state-packaging.test.ts',
  'packages/rsc-runtime/tests/state-sqlite-cross-process.test.ts',
  'packages/workbench/tests/comparisons-page-client-scope-browser.test.ts',
  'packages/workbench/tests/contributor-hmr.e2e.test.ts',
  'packages/workbench/tests/discovery-atoms-disposal.test.ts',
  'packages/workbench/tests/discovery.e2e.test.ts',
  'packages/workbench/tests/evals-real.e2e.test.ts',
  'packages/workbench/tests/examples-real.e2e.test.ts',
  'packages/workbench/tests/host-adoption.e2e.test.ts',
  'packages/workbench/tests/lifecycles-page.browser.test.tsx',
  'packages/workbench/tests/lifecycles.e2e.test.ts',
  'packages/workbench/tests/logs-real.e2e.test.ts',
  'packages/workbench/tests/mcp-app-preview-browser.test.ts',
  'packages/workbench/tests/mcp-app-frame.test.ts',
  'packages/workbench/tests/mcp-app-real.e2e.test.ts',
  'packages/workbench/tests/mcp-json-input.test.ts',
  'packages/workbench/tests/mcp-page-app-browser.test.ts',
  'packages/workbench/tests/mcp-session-timeout.e2e.test.ts',
  'packages/workbench/tests/mcp-tasks.e2e.test.ts',
  'packages/workbench/tests/overview.e2e.test.ts',
  'packages/workbench/tests/playground-real.e2e.test.ts',
  'packages/workbench/tests/rsbuild-closure.test.ts',
  'packages/workbench/tests/rsbuild-workbench.test.ts',
  'packages/workbench/tests/route-editor-atoms-disposal.test.ts',
  'packages/workbench/tests/runtime-document-atoms-disposal.test.ts',
  'packages/workbench/tests/runtime-inspector.test.ts',
  'packages/workbench/tests/runtime-consent-dialog.test.ts',
  'packages/workbench/tests/runtime-playground-capture-cleanup.test.ts',
  'packages/workbench/tests/runtime-playground.e2e.test.ts',
  'packages/workbench/tests/runtime-playground-hmr.e2e.test.ts',
  'packages/workbench/tests/workbench-dev-command.test.ts',
];

/**
 * Evidence-capture harnesses: browser journeys whose product is a
 * documentation artifact (screenshots + evidence.json), not a per-PR
 * behavioral proof. The behavioral contracts they exercise (HMR activation,
 * last-good retention, recovery) are already covered per PR by
 * runtime-playground.e2e.test.ts and runtime-playground-hmr.e2e.test.ts in
 * the integration pool. Fast capture cleanup contracts stay per PR in
 * runtime-playground-capture-cleanup.test.ts. The evidence journey runs
 * through the root `test:evidence` script in CI's nightly schedule instead —
 * evidence regenerates when the flow changes, not on every PR (#128).
 */
export const nightlyEvidenceTestFiles: readonly string[] = [
  'packages/workbench/tests/runtime-playground-capture.test.ts',
];

/**
 * Installed-host contract proofs: every test spawns the real `claude` /
 * `codex` CLI and the whole file skips unless
 * AGENT_BUNDLE_NATIVE_HOST_CONTRACTS=1, so no per-PR pool collects it. It
 * runs through rstest.native-host.config.ts (`pnpm test:native-host`) on one
 * worker, the shape a real host session needs — not next to 3,600 other
 * tests in the unit pool, and not as 29 skips per integration run (#576).
 */
export const nativeHostTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/host-adapters.native.test.ts',
];

/**
 * Official MCP server conformance runs only through the manually dispatched
 * lane. It builds one generated fixture, opens loopback HTTP, and invokes the
 * external runner, so no default Rstest pool may collect it.
 */
export const mcpConformanceTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/mcp-conformance.test.ts',
];

/**
 * Pack-and-install tests: each one consumes the run-level release tarball
 * (and usually a clean `npm install` of it), which dominates the serialized
 * integration pool. They run through the root `test:packed` /
 * `test:packed:native` scripts instead — CI's release-gates job and the
 * native-host-smoke workflow keep them covered — and stay excluded from the
 * parallel unit pool. packed-release.e2e lives here (not in the integration
 * pool) so `pnpm test` and the release gates don't each run the same long
 * packed-browser suite. `rstest.packed.config.ts` does not cap `test:packed`
 * workers; pack destinations and tmp roots are per RSTEST_WORKER_ID.
 */
export const packedTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/dev-workbench-packaging.test.ts',
  'packages/agent-bundle/tests/packed-consumer.test.ts',
  'packages/agent-bundle/tests/packed-consumer-typescript.test.ts',
  'packages/agent-bundle/tests/packed-host-install-proof.test.ts',
  'packages/agent-bundle/tests/packed-native-smoke.test.ts',
  'packages/agent-bundle/tests/packed-serve-app-command.test.ts',
  'packages/agent-bundle/tests/packed-stdio-projection.test.ts',
  'packages/agent-bundle/tests/public-api-packed.test.ts',
  'packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts',
  'packages/create-agent-bundle/tests/scaffold-packed.e2e.test.ts',
  'packages/rsc-runtime/tests/packed-entry-identity.test.ts',
  'packages/workbench/tests/packed-release.e2e.test.ts',
];

/**
 * Release-boundary-only pack-and-install tests: the scaffolder template
 * matrix beyond the per-PR minimal-template smoke. Runs through
 * `test:packed:release` (check:release and CI's nightly schedule), not on
 * every PR — the per-PR release gates keep one full scaffold journey via
 * scaffold-packed.e2e.test.ts.
 */
export const packedReleaseOnlyTestFiles: readonly string[] = [
  'packages/create-agent-bundle/tests/scaffold-packed-matrix.e2e.test.ts',
];

/**
 * Route-unit tests (#103): they render route modules through the real Agent
 * renderer, which requires React's `react-server` condition. That is a
 * process flag, so the level owns its own pool — `test:route-unit`, built from
 * the shipped `agentBundleRstest()` helper — and the workspace pools exclude
 * it. A route-unit pass is not transport, browser, or artifact proof.
 */
export const routeUnitTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/route-unit/**',
];

/**
 * In-process projection tests (#103 stage 2): the `mcp-in-memory` and
 * `cli-dispatch` proof levels. They render routes, so they need the same
 * `react-server` process condition the route-unit level needs, but they get
 * their own pool and their own directory so the levels stay visibly separate
 * — `pnpm test:projection`. Neither level is process or artifact proof; the
 * `packed-stdio` level lives in the packed pool.
 */
export const projectionTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/projection/**',
];

/**
 * Checked-in scaffolding templates ship their own test files; they run inside
 * scaffolded projects (the packed e2e drives them through each project's
 * `check`), never through the workspace pools, whose include glob would
 * otherwise pick them up.
 */
export const templateTestFiles: readonly string[] = [
  'packages/create-agent-bundle/templates/**',
];

/**
 * Fixture projects that carry their own Rstest pools: their test files run
 * inside the fixture through its own configuration (the spawning repository
 * test drives them, e.g. rstest-meta-consumer.test.ts over
 * `fixtures/meta-consumer`), never through the workspace pools, whose include
 * glob would otherwise collect them without the preset that makes them load.
 */
export const fixtureProjectTestFiles: readonly string[] = [
  'packages/agent-bundle/fixtures/**/tests/**',
];
