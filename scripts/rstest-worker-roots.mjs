/**
 * Ownership and cleanup of the hashed Rstest worker roots.
 *
 * `rstest.worker-isolation.ts` derives each worker's private temp root as
 * `/tmp/ab-rstest-<hash16>` — directly under the system temp directory, never
 * under the host `TMPDIR`, because Chrome and the Doctor socket fixtures create
 * AF_UNIX sockets inside it and Linux caps socket paths at 108 bytes. The hash
 * includes the invoking process id, so a runner such as `scripts/local-ci.mjs`
 * cannot predict the paths a finished leg created. Every root therefore carries
 * an owner marker naming the host `TMPDIR` it was derived from and the process
 * that created it; a runner that owns that `TMPDIR` can remove exactly those
 * roots once the run has finished, and nothing else.
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Parent directory of every non-Windows worker root (see rstestWorkerRootPath). */
export const rstestWorkerRootsParent = '/tmp';
/** Directory-name prefix of every non-Windows worker root. */
export const rstestWorkerRootPrefix = 'ab-rstest-';
/** Owner marker written into each worker root by `rstestWorkerRoot()`. */
export const rstestWorkerRootOwnerFile = '.ab-rstest-owner.json';

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
 * Remove the worker roots owned by a finished run: those whose owner marker
 * names `temporaryRoot` as the host `TMPDIR` they were derived from and whose
 * creating process has exited. Roots without a readable marker, roots owned by
 * another `TMPDIR`, and roots whose owning process is still alive are never
 * touched. Returns the roots removed and the live roots retained.
 */
export const removeOwnedRstestWorkerRoots = async (options) => {
  const parent = options.parent ?? rstestWorkerRootsParent;
  const isAlive = options.isAlive ?? processIsAlive;
  const removed = [];
  const retained = [];
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return { removed, retained };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(rstestWorkerRootPrefix)) continue;
    const root = join(parent, entry.name);
    let owner;
    try {
      owner = JSON.parse(await readFile(join(root, rstestWorkerRootOwnerFile), 'utf8'));
    } catch {
      continue;
    }
    if (owner === null || typeof owner !== 'object' || owner.temporaryRoot !== options.temporaryRoot) continue;
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && isAlive(owner.pid)) {
      retained.push(root);
      continue;
    }
    await rm(root, { recursive: true, force: true });
    removed.push(root);
  }
  removed.sort();
  retained.sort();
  return { removed, retained };
};
