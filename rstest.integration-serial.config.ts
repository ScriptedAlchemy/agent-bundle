import { defineConfig } from '@rstest/core';

import { serialIntegrationTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Integration files that rewrite workspace-shared artifacts (see the
 * serialIntegrationTestFiles doc in rstest.integration-tests.ts). One worker
 * only: they rebuild or repack shared package dist directories that every
 * other file in this group also reads.
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...serialIntegrationTestFiles],
  pool: { maxWorkers: 1 },
});
