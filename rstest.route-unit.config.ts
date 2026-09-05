import { resolve } from 'node:path';

import { defineConfig } from '@rstest/core';

import { agentBundleRstest } from './packages/agent-bundle/src/rstest/index.ts';
import { poolTimeouts, workspaceGlobalSetup, workspaceSetupFiles } from './rstest.pools.ts';
import { rstestHygiene } from './rstest.rslib.ts';

/**
 * The repository's own route-unit pool, built from the consumer configuration
 * helper so the shipped surface is what CI exercises. The route-unit level
 * needs the `react-server` Node condition, which is a pool-level process
 * flag — that is why it is a separate run from `rstest.unit.config.ts` and not
 * a project inside it. The shipped helper carries no per-test restoration
 * policy, no per-worker temp isolation and no orchestrator hooks (those are
 * the consumer's call), so the workspace pool adds its own: the isolation
 * setup runs before the helper's generated route registry, as in every other
 * pool, so `mkdtemp(tmpdir())` and spawned children land in the worker root.
 */
const helper = await agentBundleRstest({
  include: ['packages/agent-bundle/tests/route-unit/**/*.test.ts'],
  root: resolve(import.meta.dirname, 'packages/agent-bundle/fixtures/route-harness'),
});

export default defineConfig({
  ...helper,
  globalSetup: [...workspaceGlobalSetup],
  setupFiles: [...workspaceSetupFiles, ...helper.setupFiles],
  ...rstestHygiene,
  // lifecycle-replay.test.ts is the pool's long file (12.3 s of tests across
  // its cases in the #576 audit); 30 s per case keeps >2× headroom over the
  // slowest of them without hiding a hang.
  ...poolTimeouts(30_000),
});
