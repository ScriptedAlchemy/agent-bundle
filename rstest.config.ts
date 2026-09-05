import { defineConfig } from '@rstest/core';

import {
  fixtureProjectTestFiles,
  mcpConformanceTestFiles,
  nativeHostTestFiles,
  projectionTestFiles,
  routeUnitTestFiles,
  templateTestFiles,
  workspaceTestFileGlob,
} from './rstest.integration-tests.ts';
import {
  examplePayloadGlobalSetup,
  poolTimeouts,
  processPoolMaxWorkers,
  processPoolTimeScale,
  workspaceSetupFiles,
} from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * The default config: what `rstest <files>` runs when a script names files
 * without choosing a pool (`test:host-install`, `test:packed:native`,
 * `test:session`, `test:examples:browser`) and what `test:watch` discovers.
 * Its scope is every test the adapter-less pools do not own, so integration,
 * packed and evidence files land here alongside the unit files. It therefore
 * carries the process pool's shape — the worker cap, the polling scale and
 * the 30 s floor that Chrome + dev-server + rsbuild files need — rather than
 * Rstest's cores - 1 workers and 5 s default, which the CI
 * `host-install-proofs` job (dev-host-install.test.ts, 30 s per host) would
 * otherwise run under.
 */
const maxWorkers = processPoolMaxWorkers();

export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [workspaceTestFileGlob],
  exclude: [
    ...fixtureProjectTestFiles,
    ...mcpConformanceTestFiles,
    ...nativeHostTestFiles,
    ...projectionTestFiles,
    ...routeUnitTestFiles,
    ...templateTestFiles,
  ],
  // The e2e fixtures copy the shared rsc-agent-runtime example dist; build it
  // once in the orchestrator so parallel workers never race the ensure-build.
  globalSetup: [...examplePayloadGlobalSetup],
  pool: { maxWorkers },
  setupFiles: [...workspaceSetupFiles],
  // isolate: false would cut Playwright startup cost, but the log pipeline
  // suites rely on per-file module isolation (verified: logs-real.e2e fails
  // when sharing a worker with the other log suites).
  env: { AGENT_BUNDLE_TEST_TIME_SCALE: String(processPoolTimeScale(maxWorkers)) },
  ...poolTimeouts(30_000),
});
