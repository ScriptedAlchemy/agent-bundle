import { defineConfig } from '@rstest/core';

import { withAgentBundleRslibConfig } from '../../rstest.rslib.ts';

export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  env: { AGENT_BUNDLE_LIFECYCLE_E2E: '1' },
  globalSetup: ['../../rstest.integration.setup.ts'],
  include: ['tests/lifecycles.e2e.test.ts'],
  isolate: true,
  root: import.meta.dirname,
  setupFiles: ['../../rstest.setup.ts'],
  testTimeout: 30_000,
});
