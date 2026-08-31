import { defineConfig } from '@rstest/core';

import { templateTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [
    'packages/**/tests/**/*.test.ts',
  ],
  exclude: [...templateTestFiles],
  setupFiles: ['./rstest.setup.ts'],
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
});
