import { defineConfig } from '@rstest/core';

import { integrationTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/** Build- and process-running tests: Rslib/Rsbuild caches and output paths are process-shared, so one worker only. */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...integrationTestFiles],
  pool: { maxWorkers: 1 },
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
});
