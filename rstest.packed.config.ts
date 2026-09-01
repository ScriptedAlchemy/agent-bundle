import { defineConfig } from '@rstest/core';

import { packedReleaseOnlyTestFiles, packedTestFiles } from './rstest.integration-tests.ts';
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
  setupFiles: ['./rstest.setup.ts'],
});
