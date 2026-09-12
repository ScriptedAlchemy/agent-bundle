import { defineConfig } from '@rstest/core';

import {
  poolTimeouts,
  processPoolMaxWorkers,
  processPoolTimeScale,
  workspaceGlobalSetup,
  workspaceSetupFiles,
} from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * Hosted three-OS slice (`pnpm test:host-filesystem`): host-install
 * rollback/ownership, durable-fs, packaged installer-bin, and the #769
 * internal-child policy. It is not `rstest.config.ts` — that config's
 * orchestrator builds `examples/rsc-agent-runtime` for Workbench e2e
 * fixtures, which this slice never copies and which fails on Windows
 * (`hook/index.js` vs `hook\\index.js` in runtime-assets.json).
 */
const maxWorkers = processPoolMaxWorkers();

export const hostFilesystemTestFiles = [
  'packages/agent-bundle/tests/dev-host-install.test.ts',
  'packages/agent-bundle/tests/dev-host-install-manager.test.ts',
  'packages/agent-bundle/tests/internal-child-resolution-policy.test.ts',
  'packages/agent-bundle/tests/install.test.ts',
  'packages/agent-bundle/tests/uninstall.test.ts',
  'packages/agent-bundle/tests/durable-fs.test.ts',
  'packages/agent-bundle/tests/npm-cli-resolution.test.ts',
  'packages/agent-bundle/tests/packed-install-bin.test.ts',
  'packages/agent-bundle/tests/rstest-worker-isolation.test.ts',
] as const;

export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  include: [...hostFilesystemTestFiles],
  globalSetup: [...workspaceGlobalSetup],
  pool: { maxWorkers },
  setupFiles: [...workspaceSetupFiles],
  env: { AGENT_BUNDLE_TEST_TIME_SCALE: String(processPoolTimeScale(maxWorkers)) },
  ...poolTimeouts(30_000),
});
