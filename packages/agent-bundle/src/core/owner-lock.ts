import { isErrno } from './errors.ts';

/**
 * Shared single-writer owner-lock machinery.
 *
 * Three on-disk protocols use it and their wire formats intentionally differ
 * (they must stay compatible with existing persisted state):
 *
 * - the playground store's `.owner.lock` (`{pid, token}` with a canonical v4
 *   UUID token, released and recovered in place),
 * - the eval run store's `owner.json` (`{createdAt, nonce, pid}`, written once
 *   for an immutable run and never released), and
 * - the dev epoch store's `dev.lock` (link-published owner document whose
 *   stale holders are cleared through a separate recovery gate).
 *
 * The shared algorithm is the exclusive-create acquisition: attempt an
 * exclusive create of the serialized owner document, and on EEXIST judge the
 * surviving owner (typically via a pid liveness probe) before failing or
 * retrying. Serialization, fsync policy, and recovery unlinks remain
 * store-specific callbacks because their durability guarantees differ.
 */

/** True when a process with this pid currently exists (EPERM still means alive). */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
};

/** Returned by `create` to route a lost publication race to the contention judge without a synthetic EEXIST. */
export const ownerLockRaceLost: unique symbol = Symbol('agent-bundle.owner-lock.race-lost');

export interface AcquireOwnerLockOptions<Result> {
  /**
   * Exclusively creates the owner document and returns the acquisition result.
   * A lost race routes to the contention judge, signalled either by an EEXIST
   * failure or by returning `ownerLockRaceLost`; any other failure aborts the
   * acquisition unchanged.
   */
  readonly create: () => Promise<Result | typeof ownerLockRaceLost>;
  /**
   * Judges the owner that won the exclusive create. Throws the store's
   * ownership error when the owner is live, returns a result to adopt it, or
   * returns undefined after clearing a stale owner so the create can retry.
   */
  readonly onContention: () => Promise<Result | undefined>;
  /** Exclusive-create attempts before conceding. Defaults to one. */
  readonly attempts?: number;
  /** Error thrown when every attempt lost the exclusive create. */
  readonly exhausted: () => Error;
}

/** Exclusive-create owner acquisition shared by the playground store, eval run store, and dev lock. */
export const acquireOwnerLockFile = async <Result>(options: AcquireOwnerLockOptions<Result>): Promise<Result> => {
  const attempts = options.attempts ?? 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const created = await options.create();
      if (created !== ownerLockRaceLost) return created;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    const adopted = await options.onContention();
    if (adopted !== undefined) return adopted;
  }
  throw options.exhausted();
};
