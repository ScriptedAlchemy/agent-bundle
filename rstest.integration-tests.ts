/**
 * Test files that run real builds (Rslib/Rsbuild), pack and install the
 * package, spawn child processes, or drive a browser. These share
 * process-wide build caches and output paths, so they run serialized on one
 * worker while every other file runs on the parallel unit pool.
 *
 * A new test file belongs here the moment it runs `build()` from src/api or
 * src/build (directly or via tests/support/build.ts), imports
 * tests/support/workbench-e2e.ts or packed-release-harness.ts, spawns a
 * process, or launches a browser; otherwise it defaults to the unit pool.
 */
export const integrationTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/agent-api.test.ts',
  'packages/agent-bundle/tests/api.test.ts',
  'packages/agent-bundle/tests/artifact-validator.test.ts',
  'packages/agent-bundle/tests/browser-stdio-bridge-spike.test.ts',
  'packages/agent-bundle/tests/build.test.ts',
  'packages/agent-bundle/tests/cli.test.ts',
  'packages/agent-bundle/tests/dev-artifact-service.test.ts',
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
  'packages/workbench/tests/inspector-modern-mcp-types.test.ts',
  'packages/workbench/tests/inspector-session-adapter-fixture.test.ts',
  'packages/workbench/tests/inspector-shell.e2e.test.ts',
  'packages/workbench/tests/logs-real.e2e.test.ts',
  'packages/workbench/tests/mcp-app-preview-browser.test.ts',
  'packages/workbench/tests/mcp-app-frame.test.ts',
  'packages/workbench/tests/mcp-app-real.e2e.test.ts',
  'packages/workbench/tests/mcp-json-input.test.ts',
  'packages/workbench/tests/mcp-page-app-browser.test.ts',
  'packages/workbench/tests/mcp-session-timeout.e2e.test.ts',
  'packages/workbench/tests/overview.e2e.test.ts',
  'packages/workbench/tests/packed-release.e2e.test.ts',
  'packages/workbench/tests/playground-real.e2e.test.ts',
  'packages/workbench/tests/rsbuild-closure.test.ts',
  'packages/workbench/tests/rsbuild-workbench.test.ts',
  'packages/workbench/tests/runtime-inspector.test.ts',
  'packages/workbench/tests/runtime-consent-dialog.test.ts',
  'packages/workbench/tests/runtime-playground-capture.test.ts',
  'packages/workbench/tests/runtime-playground.e2e.test.ts',
  'packages/workbench/tests/runtime-playground-hmr.e2e.test.ts',
  'packages/workbench/tests/sync-inspector.test.ts',
  'packages/workbench/tests/workbench-dev-command.test.ts',
];

/**
 * Integration files that WRITE to workspace-shared locations and therefore
 * cannot run alongside other integration files:
 *
 * - inspector-shell.e2e rewrites `packages/workbench/dist` with an explicit
 *   development-mode artifact (the build itself is under test).
 * - packed-release.e2e can run a root `pnpm build` (rewriting
 *   `packages/{agent-bundle,rsc-runtime,workbench}/dist`) when
 *   AGENT_BUNDLE_PACKAGE_PREBUILT is unset, and always runs `npm pack`
 *   plus a packed dev server on a pre-reserved (not ephemeral) port.
 *
 * They run on one worker via rstest.integration-serial.config.ts after the
 * parallel pool finishes (rstest orders files alphabetically, so
 * packed-release packs the agent-bundle dist copy that is unaffected by
 * inspector-shell's workbench dist rewrite).
 */
export const serialIntegrationTestFiles: readonly string[] = [
  'packages/workbench/tests/inspector-shell.e2e.test.ts',
  'packages/workbench/tests/packed-release.e2e.test.ts',
];

/**
 * Integration files safe on parallel workers: they create per-test fixtures
 * with `mkdtemp`, bind servers on ephemeral ports (`port: 0` or rsbuild's
 * silent free-port fallback), and only READ the prebuilt shared artifacts
 * (`packages/workbench/dist`, `packages/agent-bundle/dist`).
 */
export const parallelIntegrationTestFiles: readonly string[] =
  integrationTestFiles.filter((file) => !serialIntegrationTestFiles.includes(file));

/**
 * Pack-and-install tests: each one runs `npm pack` (and usually a clean
 * `npm install` of the tarball), which dominates the serialized integration
 * pool. They run through the root `test:packed` / `test:packed:native`
 * scripts instead — CI's release-gates job (`check:release`) and the
 * native-host-smoke workflow keep them covered — and stay excluded from the
 * parallel unit pool.
 */
export const packedTestFiles: readonly string[] = [
  'packages/agent-bundle/tests/dev-workbench-packaging.test.ts',
  'packages/agent-bundle/tests/packed-consumer.test.ts',
  'packages/agent-bundle/tests/packed-native-smoke.test.ts',
  'packages/agent-bundle/tests/public-api-packed.test.ts',
  'packages/agent-bundle/tests/release-audit.test.ts',
  'packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts',
];
