import { defineConfig } from '@rstest/core';

import { nightlyEvidenceTestFiles } from './rstest.integration-tests.ts';
import { examplePayloadGlobalSetup, poolTimeouts, workspaceSetupFiles } from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * The nightly evidence-capture pool (`pnpm test:evidence`): the single-file
 * documentation-artifact journeys listed in nightlyEvidenceTestFiles. One
 * worker — each journey drives its own Chrome + dev-server + rsbuild trio
 * end to end, so there is nothing to parallelize — and the same shared
 * example-payload globalSetup the integration pool uses. The pool passes
 * with an empty list so the nightly stays green while no journey is listed.
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...nightlyEvidenceTestFiles],
  globalSetup: [...examplePayloadGlobalSetup],
  pool: { maxWorkers: 1 },
  setupFiles: [...workspaceSetupFiles],
  isolate: true,
  passWithNoTests: true,
  ...poolTimeouts(30_000),
});
