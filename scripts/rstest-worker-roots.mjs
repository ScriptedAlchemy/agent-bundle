/**
 * Ownership and cleanup of the hashed Rstest worker roots.
 *
 * `rstest.worker-isolation.ts` derives each worker's private temp root as
 * `/tmp/ab-rstest-<hash16>` — directly under the system temp directory, never
 * under the host `TMPDIR`, because Chrome and the Doctor socket fixtures create
 * AF_UNIX sockets inside it and Linux caps socket paths at 108 bytes. The hash
 * includes the invoking process id, so neither the Rstest orchestrator nor a
 * runner such as `scripts/local-ci.mjs` can predict the paths a finished run
 * created. Every root therefore carries an owner marker, and a sweeper removes
 * exactly the roots whose marker names what it owns, and nothing else:
 *
 * - `removeRunRstestWorkerRoots` matches the marker's `runId`, the id the
 *   pool's `globalSetup` (rstest.global-setup.ts) tags an invocation with and
 *   its workers inherit; the pool's teardown removes its own roots by it.
 * - `removeOwnedRstestWorkerRoots` matches the marker's `temporaryRoot`, the
 *   host `TMPDIR` the root was derived from; a runner that owns a private
 *   `TMPDIR` (each local-CI leg) sweeps by it, catching roots whose pool never
 *   reached teardown.
 *
 * Both retain a matching root whose creating process is still alive.
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Parent directory of every non-Windows worker root (see rstestWorkerRootPath). */
export const rstestWorkerRootsParent = '/tmp';
/** Directory-name prefix of every non-Windows worker root. */
export const rstestWorkerRootPrefix = 'ab-rstest-';
/** Owner marker written into each worker root by `rstestWorkerRoot()`. */
export const rstestWorkerRootOwnerFile = '.ab-rstest-owner.json';
/**
 * Environment variable carrying the run id of the current Rstest invocation.
 * rstest.global-setup.ts sets it (unless an outer runner already did) and every
 * worker's owner marker records it as `runId`.
 */
export const rstestRunIdVariable = 'AGENT_BUNDLE_RSTEST_RUN_ID';

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
};

/**
 * Markers read at once. A host that accumulated tens of thousands of roots
 * before the pool teardown existed makes a sequential sweep take >10 s per
 * run; sixteen concurrent reads bring it under 4 s, and more gains nothing.
 */
const sweepConcurrency = 16;

/**
 * Walk `parent` for worker roots and remove those whose owner marker `owns`
 * accepts and whose creating process has exited. Roots without a readable
 * marker, roots `owns` rejects, and roots whose owning process is still alive
 * are never touched. Returns the roots removed and the live roots retained.
 */
const sweepRstestWorkerRoots = async ({ parent, isAlive, owns }) => {
  const removed = [];
  const retained = [];
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return { removed, retained };
  }
  const roots = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(rstestWorkerRootPrefix))
    .map((entry) => join(parent, entry.name));
  const visit = async (root) => {
    let owner;
    try {
      owner = JSON.parse(await readFile(join(root, rstestWorkerRootOwnerFile), 'utf8'));
    } catch {
      return;
    }
    if (owner === null || typeof owner !== 'object' || !owns(owner)) return;
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && isAlive(owner.pid)) {
      retained.push(root);
      return;
    }
    await rm(root, { recursive: true, force: true });
    removed.push(root);
  };
  for (let index = 0; index < roots.length; index += sweepConcurrency) {
    await Promise.all(roots.slice(index, index + sweepConcurrency).map(visit));
  }
  removed.sort();
  retained.sort();
  return { removed, retained };
};

/**
 * Remove the worker roots owned by a finished run: those whose owner marker
 * names `temporaryRoot` as the host `TMPDIR` they were derived from and whose
 * creating process has exited. Roots without a readable marker, roots owned by
 * another `TMPDIR`, and roots whose owning process is still alive are never
 * touched. Returns the roots removed and the live roots retained.
 */
export const removeOwnedRstestWorkerRoots = async (options) =>
  sweepRstestWorkerRoots({
    parent: options.parent ?? rstestWorkerRootsParent,
    isAlive: options.isAlive ?? processIsAlive,
    owns: (owner) => owner.temporaryRoot === options.temporaryRoot,
  });

/**
 * Remove the worker roots one Rstest invocation created: those whose owner
 * marker records `runId` and whose creating process has exited. Roots without
 * a readable marker, roots whose marker carries another run id, and roots
 * whose owning process is still alive are never touched; an empty `runId`
 * matches nothing, so an unset variable can never widen the sweep.
 *
 * `reclaimUntaggedFrom`, when given, also removes the roots whose marker
 * carries no run id at all and names that directory as `cwd`: roots left by
 * this checkout's pools before the teardown existed (or by a pool run without
 * rstest.global-setup.ts), which nothing else ever removes and which every
 * later sweep would otherwise keep reading. The liveness check applies to
 * them as well. Returns the roots removed and the live roots retained.
 */
export const removeRunRstestWorkerRoots = async (options) => {
  const { runId, reclaimUntaggedFrom } = options;
  if (typeof runId !== 'string' || runId === '') return { removed: [], retained: [] };
  const reclaimsUntagged = typeof reclaimUntaggedFrom === 'string' && reclaimUntaggedFrom !== '';
  return sweepRstestWorkerRoots({
    parent: options.parent ?? rstestWorkerRootsParent,
    isAlive: options.isAlive ?? processIsAlive,
    owns: (owner) => owner.runId === runId
      || (reclaimsUntagged && owner.runId === undefined && owner.cwd === reclaimUntaggedFrom),
  });
};
