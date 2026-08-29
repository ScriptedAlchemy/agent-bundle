import { availableParallelism } from 'node:os';

import { defineConfig } from '@rstest/core';

import { parallelIntegrationTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Worker count for the parallel integration pool. Half the cores keeps
 * browser + dev-server pairs from starving each other, the cap of 4 bounds
 * memory on large machines, and two-core CI still resolves to one worker.
 * AGENT_BUNDLE_INTEGRATION_MAX_WORKERS overrides the computed value (e.g. to
 * force a serial run when measuring or bisecting).
 */
const overrideWorkers = Number(process.env['AGENT_BUNDLE_INTEGRATION_MAX_WORKERS'] ?? '');
const maxWorkers = Number.isSafeInteger(overrideWorkers) && overrideWorkers >= 1
  ? overrideWorkers
  : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

/**
 * Build- and process-running tests that only read workspace-shared artifacts;
 * files that WRITE shared locations run serialized afterwards through
 * rstest.integration-serial.config.ts (rstest has no per-project pool or
 * isolate settings, so the split lives in two configs chained by
 * `test:integration:run`).
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...parallelIntegrationTestFiles],
  pool: { maxWorkers },
  // Concurrent Chrome + dev-server + rsbuild pairs contend for cores, so
  // parallel runs double the polling budgets (see tests/support/time-scale.ts).
  env: { AGENT_BUNDLE_TEST_TIME_SCALE: maxWorkers > 1 ? '2' : '1' },
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
});
