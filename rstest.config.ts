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
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
});
