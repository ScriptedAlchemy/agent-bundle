import { defineConfig } from '@rstest/core';
import { withRslibConfig } from '@rstest/adapter-rslib';

import { integrationTestFiles } from './rstest.integration-tests.ts';

/** Build-free, process-free tests only; safe on parallel workers. `npm test` runs this before the integration config. */
export default defineConfig({
  extends: withRslibConfig(),
  include: [
    'packages/**/tests/**/*.test.ts',
    'packages/workbench/src/inspector/vendor/clients/web/src/utils/inspectorTabs.test.ts',
  ],
  exclude: [...integrationTestFiles],
});
