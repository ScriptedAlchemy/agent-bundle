import { defineConfig } from '@rstest/core';

import { integrationTestFiles, packedTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/** Build-free, process-free tests only; safe on parallel workers. `pnpm test` runs this before the integration config. */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [
    'packages/**/tests/**/*.test.ts',
  ],
  exclude: [...integrationTestFiles, ...packedTestFiles],
});
