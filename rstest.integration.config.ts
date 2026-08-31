import { availableParallelism } from 'node:os';

import { defineConfig } from '@rstest/core';

import { integrationTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Rstest computes worker count from CPU and command mode when pool.maxWorkers
 * is omitted. Shared cache, tmp, and pack roots are isolated per worker via
 * RSTEST_WORKER_ID (see rstest.setup.ts).
 */

/**
 * Polling budgets scale with contention. The auto-sized pool runs multiple
 * workers on any multi-core machine, which needs at least 2 (see the env
 * comment below); an externally set AGENT_BUNDLE_TEST_TIME_SCALE raises it
 * further when the machine is shared — scripts/local-ci.mjs passes 4 (hosted
 * CI's own scale) because it runs three Node legs plus the release gates
 * concurrently. The external value never lowers the scale below what the
 * pool shape requires.
 */
const externalTimeScale = Number(process.env['AGENT_BUNDLE_TEST_TIME_SCALE'] ?? '');
const poolTimeScale = availableParallelism() > 1 ? 2 : 1;
const timeScale = Number.isSafeInteger(externalTimeScale) && externalTimeScale >= 1
  ? Math.max(externalTimeScale, poolTimeScale)
  : poolTimeScale;

/**
 * Build- and process-running tests that only read workspace-shared artifacts;
 * files that WRITE shared locations (root builds, `npm pack`) run through the
 * `test:packed` script instead (see rstest.integration-tests.ts).
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...integrationTestFiles],
  setupFiles: ['./rstest.setup.ts'],
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
  isolate: true,
  // Concurrent Chrome + dev-server + rsbuild pairs contend for cores, so
  // parallel runs double the polling budgets (see tests/support/time-scale.ts)
  // and raise the 5s default test timeout, which real in-process builds can
  // exceed when workers share the machine. Explicit per-test timeouts win.
  env: { AGENT_BUNDLE_TEST_TIME_SCALE: String(timeScale) },
  testTimeout: 30_000,
});
