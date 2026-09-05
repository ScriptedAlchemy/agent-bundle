import { resolve } from 'node:path';

import { defineConfig } from '@rstest/core';

import { agentBundleRstest } from './packages/agent-bundle/src/rstest/index.ts';
import { rstestHygiene } from './rstest.rslib.ts';

/**
 * The repository's own route-unit pool, built from the consumer configuration
 * helper so the shipped surface is what CI exercises. The route-unit level
 * needs the `react-server` Node condition, which is a pool-level process
 * flag — that is why it is a separate run from `rstest.unit.config.ts` and not
 * a project inside it. The shipped helper carries no per-test restoration
 * policy (that is the consumer's call), so the workspace pool adds its own.
 */
export default defineConfig({
  ...(await agentBundleRstest({
    include: ['packages/agent-bundle/tests/route-unit/**/*.test.ts'],
    root: resolve(import.meta.dirname, 'packages/agent-bundle/fixtures/route-harness'),
  })),
  ...rstestHygiene,
});
