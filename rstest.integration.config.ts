import { defineConfig } from '@rstest/core';

import { integrationTestFiles } from './rstest.integration-tests.ts';
import {
  examplePayloadGlobalSetup,
  poolTimeouts,
  processPoolMaxWorkers,
  processPoolTimeScale,
  workspaceSetupFiles,
} from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Worker count and polling scale come from rstest.pools.ts (half the cores,
 * clamped to 1..4; scale 2 whenever more than one worker shares the
 * machine). Shared cache, tmp, and pack roots are isolated per worker via
 * RSTEST_WORKER_ID (see rstest.setup.ts).
 */
const maxWorkers = processPoolMaxWorkers();

/**
 * Build- and process-running tests that only read workspace-shared artifacts;
 * files that WRITE shared locations (root builds, `npm pack`) run through the
 * `test:packed` script instead (see rstest.integration-tests.ts).
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...integrationTestFiles],
  // Refuses a stale dist, tags the run for worker-root teardown, and builds
  // the rsc-agent-runtime example payload once before workers start; parallel
  // workers must never race that shared ensure-build (see
  // rstest.integration.setup.ts).
  globalSetup: [...examplePayloadGlobalSetup],
  pool: { maxWorkers },
  setupFiles: [...workspaceSetupFiles],
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
  isolate: true,
  // Concurrent Chrome + dev-server + rsbuild pairs contend for cores, so
  // parallel runs double the polling budgets (see tests/support/time-scale.ts)
  // and raise the 5s default test timeout, which real in-process builds can
  // exceed when workers share the machine. Explicit per-test timeouts win.
  env: { AGENT_BUNDLE_TEST_TIME_SCALE: String(processPoolTimeScale(maxWorkers)) },
  ...poolTimeouts(30_000),
});
