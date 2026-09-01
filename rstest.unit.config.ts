import { defineConfig } from '@rstest/core';

import {
  integrationTestFiles,
  nightlyEvidenceTestFiles,
  packedTestFiles,
  projectionTestFiles,
  routeUnitTestFiles,
  templateTestFiles,
} from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/** Build-free, process-free tests only; safe on parallel workers. `pnpm test` runs this before the integration config. */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [
    'packages/**/tests/**/*.test.ts',
  ],
  exclude: [
    ...integrationTestFiles,
    ...nightlyEvidenceTestFiles,
    ...packedTestFiles,
    ...projectionTestFiles,
    ...routeUnitTestFiles,
    ...templateTestFiles,
  ],
  setupFiles: ['./rstest.setup.ts'],
  // Unit files construct per-test services; logs-real.e2e is not in this pool.
  isolate: false,
});
