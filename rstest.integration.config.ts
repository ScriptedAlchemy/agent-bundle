import { availableParallelism } from 'node:os';

import { defineConfig } from '@rstest/core';

import { integrationTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Worker count for the parallel integration pool. Half the cores keeps
 * browser + dev-server pairs from starving each other and the cap of 4 bounds
 * memory on large machines. CI pins one worker explicitly: hosted runners
 * report 4 cores (which would compute 2 workers), but each Chrome +
 * dev-server + rsbuild pair already saturates them, and 2-worker matrix runs
 * flaked on a rotating test per leg even at timeScale 4. Parallelism is a
 * development-machine speedup; CI keeps the serialized shape it was tuned
 * for. AGENT_BUNDLE_INTEGRATION_MAX_WORKERS overrides the computed value
 * (e.g. to measure a parallel CI run or bisect locally in serial).
 */
const overrideWorkers = Number(process.env['AGENT_BUNDLE_INTEGRATION_MAX_WORKERS'] ?? '');
const maxWorkers = Number.isSafeInteger(overrideWorkers) && overrideWorkers >= 1
  ? overrideWorkers
  : process.env['CI'] !== undefined
    ? 1
    : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

/**
 * Polling budgets scale with contention. A multi-worker pool needs at least
 * 2 (see the env comment below); an externally set
 * AGENT_BUNDLE_TEST_TIME_SCALE raises it further when the machine is shared —
 * scripts/local-ci.mjs passes 4 (hosted CI's own scale) because it runs
 * three Node legs plus the release gates concurrently. The external value
 * never lowers the scale below what the pool shape requires.
 */
const externalTimeScale = Number(process.env['AGENT_BUNDLE_TEST_TIME_SCALE'] ?? '');
const poolTimeScale = maxWorkers > 1 ? 2 : 1;
const timeScale = Number.isSafeInteger(externalTimeScale) && externalTimeScale >= 1
  ? Math.max(externalTimeScale, poolTimeScale)
  : poolTimeScale;

/**
 * Build- and process-running tests that only read workspace-shared artifacts;
 * files that WRITE shared locations (root builds, `npm pack`) run through the
 * single-worker `test:packed` script instead (see rstest.integration-tests.ts).
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...integrationTestFiles],
  pool: { maxWorkers },
  // Concurrent Chrome + dev-server + rsbuild pairs contend for cores, so
  // parallel runs double the polling budgets (see tests/support/time-scale.ts)
  // and raise the 5s default test timeout, which real in-process builds can
  // exceed when workers share the machine. Explicit per-test timeouts win.
  env: { AGENT_BUNDLE_TEST_TIME_SCALE: String(timeScale) },
  testTimeout: 30_000,
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
});
