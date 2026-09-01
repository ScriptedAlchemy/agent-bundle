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
  'packages/agent-bundle/tests/artifact-validator.test.ts',
  'packages/agent-bundle/tests/browser-stdio-bridge-spike.test.ts',
  'packages/agent-bundle/tests/build.test.ts',
  'packages/agent-bundle/tests/cli.test.ts',
  'packages/agent-bundle/tests/dev-artifact-service.test.ts',
  'packages/agent-bundle/tests/dev-package-build.test.ts',
  'packages/agent-bundle/tests/dev-workbench.test.ts',
  'packages/agent-bundle/tests/eval-claude-harness.test.ts',
  'packages/agent-bundle/tests/eval-cli.test.ts',
  'packages/agent-bundle/tests/eval-fixtures.test.ts',
  'packages/agent-bundle/tests/eval-harness.test.ts',
  'packages/agent-bundle/tests/eval-service.test.ts',
  'packages/agent-bundle/tests/eval-workbench.test.ts',
  'packages/agent-bundle/tests/examples-contract.test.ts',
  'packages/agent-bundle/tests/hook-playground-service.test.ts',
  'packages/agent-bundle/tests/hooks.test.ts',
  'packages/agent-bundle/tests/host-adapters.native.test.ts',
  'packages/agent-bundle/tests/host-adapters.test.ts',
  'packages/agent-bundle/tests/integration-matrix.test.ts',
  'packages/agent-bundle/tests/mcp-session-service.test.ts',
  'packages/agent-bundle/tests/mcp.test.ts',
  'packages/agent-bundle/tests/package-build.test.ts',
  'packages/agent-bundle/tests/path-token-resolver.test.ts',
  'packages/agent-bundle/tests/plugin-bundle.test.ts',
  'packages/agent-bundle/tests/public-api.test.ts',
  'packages/agent-bundle/tests/rsc-runtime-topology-script.test.ts',
  'packages/agent-bundle/tests/script-playground-service.test.ts',
  'packages/agent-bundle/tests/target-hook-contract.test.ts',
  'packages/agent-bundle/tests/target-mcp-runtime.test.ts',
  'packages/workbench/tests/comparisons-page-client-scope-browser.test.ts',
  'packages/workbench/tests/evals-real.e2e.test.ts',
  'packages/workbench/tests/examples-real.e2e.test.ts',
  'packages/workbench/tests/logs-real.e2e.test.ts',
  'packages/workbench/tests/mcp-app-preview-browser.test.ts',
  'packages/workbench/tests/mcp-app-frame.test.ts',
  'packages/workbench/tests/mcp-app-real.e2e.test.ts',
  'packages/workbench/tests/mcp-json-input.test.ts',
  'packages/workbench/tests/mcp-page-app-browser.test.ts',
  'packages/workbench/tests/mcp-session-timeout.e2e.test.ts',
  'packages/workbench/tests/overview.e2e.test.ts',
  'packages/workbench/tests/playground-real.e2e.test.ts',
  'packages/workbench/tests/rsbuild-closure.test.ts',
  'packages/workbench/tests/rsbuild-workbench.test.ts',
  'packages/workbench/tests/runtime-inspector.test.ts',
  'packages/workbench/tests/runtime-consent-dialog.test.ts',
  'packages/workbench/tests/runtime-playground-capture.test.ts',
  'packages/workbench/tests/runtime-playground.e2e.test.ts',
  'packages/workbench/tests/runtime-playground-hmr.e2e.test.ts',
  'packages/workbench/tests/workbench-dev-command.test.ts',
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
  'packages/agent-bundle/tests/packed-native-smoke.test.ts',
  'packages/agent-bundle/tests/public-api-packed.test.ts',
  'packages/agent-bundle/tests/release-audit.test.ts',
  'packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts',
  'packages/create-agent-bundle/tests/scaffold-packed.e2e.test.ts',
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
 * Checked-in scaffolding templates ship their own test files; they run inside
 * scaffolded projects (the packed e2e drives them through each project's
 * `check`), never through the workspace pools, whose include glob would
 * otherwise pick them up.
 */
export const templateTestFiles: readonly string[] = [
  'packages/create-agent-bundle/templates/**',
];
