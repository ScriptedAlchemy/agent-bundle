import { defineConfig } from '@rstest/core';

import { mcpConformanceTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...mcpConformanceTestFiles],
  pool: { maxWorkers: 1 },
  setupFiles: ['./rstest.setup.ts'],
  testTimeout: 180_000,
});
