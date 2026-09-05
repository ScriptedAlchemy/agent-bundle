import { randomUUID } from 'node:crypto';

import { removeRunRstestWorkerRoots, rstestRunIdVariable } from './scripts/rstest-worker-roots.mjs';

/**
 * Rstest `globalSetup` module: tags one Rstest invocation with a run id and,
 * once every test file has finished, removes exactly the worker roots that
 * invocation created — plus, as a one-time repair, the untagged roots this
 * checkout's pools left behind before the teardown existed.
 *
 * Every pool worker derives a private temp root, `/tmp/ab-rstest-<hash16>`
 * (rstest.worker-isolation.ts), and stamps it with an owner marker. Nothing on
 * the `pnpm test*` path used to remove those roots — only scripts/local-ci.mjs
 * swept the ones derived from its private TMPDIR — so a developer machine
 * accumulated one root per worker per run, tens of thousands over time.
 *
 * Mechanism. Rstest 0.11 loads `globalSetup` modules in a dedicated forked
 * process, before any test worker starts, and keeps that process alive until
 * teardown. `setup` puts the run id in `process.env`; Rstest diffs the env
 * around `setup`, relays the change to the orchestrator, and the orchestrator
 * merges its own `process.env` into each worker's runtime config, which the
 * worker applies (`setupEnv`) before its setup files run. So by the time
 * rstest.setup.ts isolates a worker and writes its owner marker, the variable
 * is set and the marker records it as `runId` (verified empirically for both
 * `isolate: true` and `isolate: false`; the pool's forked-env snapshot alone
 * would NOT have carried it, since the pool is created before global setup).
 * `teardown` runs in the same forked process after the pool has closed and
 * every worker has exited, also when a test failed, so the module-level id is
 * still at hand and no live owner is left to retain.
 *
 * Why the run id is the ownership key and not the pid or the cwd: each root's
 * hash includes the *worker's* pid, so the orchestrator cannot predict the
 * paths and pids are recycled; the cwd is shared by every invocation of the
 * same checkout — the four pools `pnpm test` runs back to back, or the three
 * local-CI legs running at once. A fresh UUID per invocation is unique across
 * concurrent runs and common to all of that run's workers, which is exactly
 * the set the teardown must remove and nothing more. An outer runner may set
 * `AGENT_BUNDLE_RSTEST_RUN_ID` itself to own the id; it then must give
 * concurrently running pools distinct ids, because each pool's teardown
 * removes every finished root carrying its id.
 *
 * Set `AGENT_BUNDLE_RSTEST_DEBUG_ROOTS` (any non-empty value) to have the
 * teardown report the roots it removed and retained on stderr.
 */

/** Debug switch: report the teardown's removed and retained roots on stderr. */
const debugRootsVariable = 'AGENT_BUNDLE_RSTEST_DEBUG_ROOTS';

/** The id `setup` tagged this invocation with; `teardown` sweeps by it. */
let runId: string | undefined;

export const setup = (): void => {
  const inherited = process.env[rstestRunIdVariable];
  runId = inherited === undefined || inherited === '' ? randomUUID() : inherited;
  process.env[rstestRunIdVariable] = runId;
};

export const teardown = async (): Promise<void> => {
  if (runId === undefined) return;
  // Untagged roots this checkout left before the teardown existed go too:
  // nothing else reclaims them, and each one is a marker every later sweep
  // would read again.
  const { removed, retained } = await removeRunRstestWorkerRoots({ reclaimUntaggedFrom: process.cwd(), runId });
  const debug = process.env[debugRootsVariable];
  if (debug === undefined || debug === '') return;
  const listed = (roots: readonly string[]): string => (roots.length === 0 ? '' : `\n  ${roots.join('\n  ')}`);
  console.error(
    `[rstest.global-setup] run ${runId}: removed ${String(removed.length)} worker root(s)${listed(removed)}`
      + `\n[rstest.global-setup] run ${runId}: retained ${String(retained.length)} live worker root(s)${listed(retained)}`,
  );
};
