import { defineConfig } from '@rstest/core';

import { nativeHostTestFiles } from './rstest.integration-tests.ts';
import { poolTimeouts, workspaceGlobalSetup, workspaceSetupFiles } from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * The installed-host contract lane (`pnpm test:native-host`): the files in
 * nativeHostTestFiles drive the real `claude` / `codex` CLIs and skip
 * themselves unless AGENT_BUNDLE_NATIVE_HOST_CONTRACTS=1, which the script
 * sets. One worker, because each case is a real host session against the
 * developer's installed CLI. The files set no per-case timeouts, so the
 * pool floor is the budget: 60 s, twice the 30–32 s the #576 audit measured
 * for the comparable real-host install variants in the integration pool.
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...nativeHostTestFiles],
  globalSetup: [...workspaceGlobalSetup],
  pool: { maxWorkers: 1 },
  setupFiles: [...workspaceSetupFiles],
  isolate: true,
  ...poolTimeouts(60_000),
});
