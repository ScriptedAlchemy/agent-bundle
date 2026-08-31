import { availableParallelism } from 'node:os';

import { defineConfig } from '@rstest/core';

import { integrationTestFiles } from './rstest.integration-tests.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Worker count for the parallel integration pool, CI and local alike: half
 * the cores (hosted runners report 4, so CI runs 2 workers), clamped to at
 * least 1 and at most 4. Rstest's own auto-sizing would run cores - 1 (3 on
 * hosted runners), but every worker here drives a Chrome + dev-server +
 * rsbuild pair, so halving keeps the pairs from starving each other and the
 * cap bounds memory on large machines; the 2-worker shape is also the one
 * the burn-in evidence covers. Shared cache, tmp, and pack roots are
 * isolated per worker via RSTEST_WORKER_ID (see rstest.setup.ts).
 *
 * History: CI briefly pinned 1 worker because early 2-worker matrix runs
 * flaked on a rotating test per leg. The causes were since fixed at the
 * source rather than by keeping the serial shape: contention-sensitive tests
 * now sequence readiness instead of racing fixed timers (e.g. the
 * script-playground descendant-drain suites), shared cold artifacts are
 * built once in the orchestrator (see globalSetup below), watched-file and
 * pid publications use staged renames, dev ports are ephemeral, and polling
 * budgets follow AGENT_BUNDLE_TEST_TIME_SCALE. Burn-ins of the 2-worker,
 * 4-core CI shape back the unpin; if a new contention flake appears, fix its
 * race — do not re-pin. AGENT_BUNDLE_INTEGRATION_MAX_WORKERS overrides the
 * computed value (e.g. to bisect locally in serial).
 */
const overrideWorkers = Number(process.env['AGENT_BUNDLE_INTEGRATION_MAX_WORKERS'] ?? '');
const maxWorkers = Number.isSafeInteger(overrideWorkers) && overrideWorkers >= 1
  ? overrideWorkers
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
 * `test:packed` script instead (see rstest.integration-tests.ts).
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...integrationTestFiles],
  // Builds the rsc-agent-runtime example payload once before workers start;
  // parallel workers must never race that shared ensure-build (see
  // rstest.integration.setup.ts).
  globalSetup: ['./rstest.integration.setup.ts'],
  pool: { maxWorkers },
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
