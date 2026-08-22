import { isErrno } from './errors.ts';

/**
 * Shared single-writer owner-lock machinery.
 *
 * Two on-disk protocols use it and their wire formats intentionally differ
 * (they must stay compatible with existing persisted state):
 *
 * - the playground store's `.owner.lock` (`{pid, token}` with a canonical v4
 *   UUID token, released and recovered in place), and
 * - the eval run store's `owner.json` (`{createdAt, nonce, pid}`, written once
 *   for an immutable run and never released).
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

export interface AcquireOwnerLockOptions<Result> {
  /**
   * Exclusively creates the owner document and returns the acquisition result.
   * Must fail with EEXIST when another owner document already occupies the
   * path; any other failure aborts the acquisition unchanged.
   */
  readonly create: () => Promise<Result>;
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

/** Exclusive-create owner acquisition shared by the playground and eval run stores. */
export const acquireOwnerLockFile = async <Result>(options: AcquireOwnerLockOptions<Result>): Promise<Result> => {
  const attempts = options.attempts ?? 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await options.create();
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    const adopted = await options.onContention();
    if (adopted !== undefined) return adopted;
  }
  throw options.exhausted();
};

/**
 * Process-wide serializer for owner-lock mutations, keyed by lock path.
 *
 * Sharing across store instances is intentional: two services recovering or
 * releasing the same on-disk lock must serialize their read-verify-unlink
 * windows even though each service holds its own instance. Entries are
 * removed as soon as the last queued mutation for a path settles, so the
 * registry never grows past the set of locks currently being mutated.
 */
export class OwnerMutationSerializer {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(path) ?? Promise.resolve();
    const boundary = Promise.withResolvers<void>();
    this.#tails.set(path, boundary.promise);
    await previous;
    try {
      return await operation();
    } finally {
      boundary.resolve();
      if (this.#tails.get(path) === boundary.promise) this.#tails.delete(path);
    }
  }
}

/** The one process-wide owner-mutation serializer every store instance shares. */
export const sharedOwnerMutationSerializer = new OwnerMutationSerializer();
