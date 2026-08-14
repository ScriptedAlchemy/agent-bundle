import { defineConfig } from '@rstest/core';
import { withRslibConfig } from '@rstest/adapter-rslib';

export default defineConfig({
  extends: withRslibConfig(),
  include: [
    'packages/**/tests/**/*.test.ts',
    'packages/workbench/src/inspector/vendor/clients/web/src/utils/inspectorTabs.test.ts',
  ],
  // Several integration tests run Rslib, whose build cache and configured
  // output paths are process-shared. Keep those builds from racing each other.
  pool: { maxWorkers: 1 },
  testEnvironment: 'node',
});
