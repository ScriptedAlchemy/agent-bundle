import { defineConfig } from '@rstest/core';

import { packedReleaseOnlyTestFiles, packedTestFiles } from './rstest.integration-tests.ts';
import { poolTimeouts, workspaceGlobalSetup, workspaceSetupFiles } from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Pack-and-install suites, normally launched through
 * `scripts/run-packed-tests.mjs` so every file consumes one shared tarball
 * per public package. `--release` (AGENT_BUNDLE_PACKED_RELEASE=1) adds the
 * release-boundary-only files — the scaffolder template matrix — on top of
 * the per-PR set. Rstest sizes the pool itself: no file writes the workspace
 * `dist` in place anymore (dev-workbench-packaging's prune test rebuilds
 * into an isolated copy), and shared tmp/npm/cache roots are per
 * RSTEST_WORKER_ID (see rstest.setup.ts).
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [
    ...packedTestFiles,
    ...(process.env['AGENT_BUNDLE_PACKED_RELEASE'] === '1' ? packedReleaseOnlyTestFiles : []),
  ],
  globalSetup: [...workspaceGlobalSetup],
  setupFiles: [...workspaceSetupFiles],
  // A pack + consumer install + host run per case: the files set their own
  // per-test budgets (up to 300 s), and this floor keeps a case that forgets
  // one from dying at Rstest's 5 s default (#576).
  ...poolTimeouts(120_000),
});
