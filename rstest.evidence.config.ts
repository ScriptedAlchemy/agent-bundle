import { defineConfig } from '@rstest/core';

import { nightlyEvidenceTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * The nightly evidence-capture pool (`pnpm test:evidence`): the single-file
 * documentation-artifact journeys listed in nightlyEvidenceTestFiles. One
 * worker — each journey drives its own Chrome + dev-server + rsbuild trio
 * end to end, so there is nothing to parallelize — and the same shared
 * example-payload globalSetup the integration pool uses, because the
 * capture harness copies `examples/rsc-agent-runtime/dist` through
 * runtime-playground-fixture.ts.
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...nightlyEvidenceTestFiles],
  globalSetup: ['./rstest.integration.setup.ts'],
  pool: { maxWorkers: 1 },
  setupFiles: ['./rstest.setup.ts'],
  isolate: true,
  testTimeout: 30_000,
});
