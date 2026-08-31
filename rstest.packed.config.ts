import { defineConfig } from '@rstest/core';

import { packedReleaseOnlyTestFiles, packedTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Pack-and-install suites, normally launched through
 * `scripts/run-packed-tests.mjs` so every file consumes one shared tarball
 * per public package. `--release` (AGENT_BUNDLE_PACKED_RELEASE=1) adds the
 * release-boundary-only files — the scaffolder template matrix — on top of
 * the per-PR set. The pool stays on one worker: dev-workbench-packaging
 * rebuilds the workspace `dist` in place while release-audit's audit script
 * packs it, so the files still contend on workspace-shared writes.
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [
    ...packedTestFiles,
    ...(process.env['AGENT_BUNDLE_PACKED_RELEASE'] === '1' ? packedReleaseOnlyTestFiles : []),
  ],
  pool: { maxWorkers: 1 },
});
