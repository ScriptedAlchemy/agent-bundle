import { serialQueue } from '../core/async.ts';

interface LeaseQueueEntry {
  pending: number;
  readonly queue: ReturnType<typeof serialQueue>;
}

/**
 * Process-wide lease registry for epoch stores.
 *
 * Cross-instance sharing is intentional: every EpochStore over the same
 * project must serialize lease transitions through one queue and observe one
 * set of reference counts, so leases survive across store instances over one
 * path (a test asserts this). Lease queues are keyed by the store's resolved
 * `.agent-bundle` path and reference counts by the absolute epoch directory.
 *
 * Entries clean themselves up only where that is provably safe: a
 * reference-count entry is deleted when its count returns to zero, and a
 * lease-queue entry is deleted once its last pending transition settles — a
 * later transition recreates the queue, and nothing can interleave because an
 * entry only leaves the map while no transition is queued against it.
 */
export class EpochLeaseRegistry {
  readonly #queues = new Map<string, LeaseQueueEntry>();
  readonly #references = new Map<string, number>();

  /** Current lease count for one absolute epoch directory path. */
  referenceCount(epochPath: string): number {
    return this.#references.get(epochPath) ?? 0;
  }

  /** Releases one lease; the entry is removed when the count reaches zero. */
  release(epochPath: string): void {
    const count = this.#references.get(epochPath) ?? 0;
    if (count <= 1) {
      this.#references.delete(epochPath);
      return;
    }
    this.#references.set(epochPath, count - 1);
  }

  retain(epochPath: string): void {
    this.#references.set(epochPath, (this.#references.get(epochPath) ?? 0) + 1);
  }

  async runLeaseTransition<T>(agentBundlePath: string, operation: () => Promise<T>): Promise<T> {
    const entry = this.#queues.get(agentBundlePath) ?? { pending: 0, queue: serialQueue() };
    this.#queues.set(agentBundlePath, entry);
    entry.pending += 1;
    try {
      return await entry.queue.run(operation);
    } finally {
      entry.pending -= 1;
      if (entry.pending === 0 && this.#queues.get(agentBundlePath) === entry) {
        this.#queues.delete(agentBundlePath);
      }
    }
  }
}

/** The one process-wide lease registry every EpochStore instance shares. */
export const sharedEpochLeaseRegistry = new EpochLeaseRegistry();
