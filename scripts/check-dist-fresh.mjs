/**
 * `node scripts/check-dist-fresh.mjs` — exits 1 with the rebuild instruction
 * when any dist `pnpm build` produces is older than its inputs, absent, or
 * contains the packed runtime fixture marker; silent and 0 otherwise. The
 * root `typecheck` script runs it first, because `tsc` types the tests against
 * `dist/*.d.ts` (scripts/dist-freshness.mjs explains the descriptors and the
 * mtime rule).
 */
import { resolve } from 'node:path';

import { assertFreshDist, workspaceBuildOutputs } from './dist-freshness.mjs';

const workspaceRoot = resolve(import.meta.dirname, '..');

try {
  assertFreshDist(workspaceBuildOutputs(workspaceRoot), { relativeTo: workspaceRoot });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
