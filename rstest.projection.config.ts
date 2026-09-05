import { resolve } from 'node:path';

import { defineConfig } from '@rstest/core';

import { agentBundleRstest } from './packages/agent-bundle/src/rstest/index.ts';
import { rstestHygiene } from './rstest.rslib.ts';

/**
 * The repository's in-process projection pool (#103 stage 2): the
 * `mcp-in-memory` and `cli-dispatch` proof levels, built from the same shipped
 * consumer configuration helper the route-unit pool uses. It is a separate run
 * from `rstest.route-unit.config.ts` so a route-unit pass and a projection
 * pass are separately reported — the levels are separate claims.
 *
 * Neither level opens a process. The `packed-stdio` level lives in the packed
 * pool (`pnpm test:packed`), which owns the run's single build and pack.
 * Per-test restoration comes from the workspace's shared policy, as in the
 * route-unit pool.
 */
export default defineConfig({
  ...(await agentBundleRstest({
    include: ['packages/agent-bundle/tests/projection/**/*.test.ts'],
    root: resolve(import.meta.dirname, 'packages/agent-bundle/fixtures/route-harness'),
  })),
  ...rstestHygiene,
});
