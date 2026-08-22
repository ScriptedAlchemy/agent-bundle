import { defineConfig } from '@rstest/core';
import { withRslibConfig } from '@rstest/adapter-rslib';

import { integrationTestFiles } from './rstest.integration-tests.ts';

/** Build- and process-running tests: Rslib/Rsbuild caches and output paths are process-shared, so one worker only. */
export default defineConfig({
  extends: withRslibConfig(),
  include: [...integrationTestFiles],
  pool: { maxWorkers: 1 },
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
});
