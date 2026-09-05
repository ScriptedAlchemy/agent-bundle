import { defineConfig } from '@rstest/core';

import { mcpConformanceTestFiles } from './rstest.integration-tests.ts';
import { poolTimeouts, workspaceGlobalSetup, workspaceSetupFiles } from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...mcpConformanceTestFiles],
  globalSetup: [...workspaceGlobalSetup],
  pool: { maxWorkers: 1 },
  setupFiles: [...workspaceSetupFiles],
  ...poolTimeouts(180_000),
});
