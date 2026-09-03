import { errorMessage } from '../../core/errors.ts';
import type {
  PlaygroundCleanupFailure,
  PlaygroundSubscribeOptions,
  PlaygroundTraceEvent,
} from './playground-protocol.ts';
import { snapshotEvent } from './playground-values.ts';

export interface PlaygroundSubscriptionEntry {
  active: boolean;
  closed: boolean;
  delivery: Promise<void>;
  draining: boolean;
  readonly onEvent: PlaygroundSubscribeOptions['onEvent'];
  readonly queue: PlaygroundTraceEvent[];
}

/** Owns bounded subscriber queues and isolates listener failures from durable session state. */
export class PlaygroundSubscriptionSet {
  readonly #cleanupFailures: PlaygroundCleanupFailure[];
  readonly #entries = new Set<PlaygroundSubscriptionEntry>();
  readonly #maximumQueue: number;

  constructor(maximumQueue: number, cleanupFailures: PlaygroundCleanupFailure[]) {
    this.#maximumQueue = maximumQueue;
    this.#cleanupFailures = cleanupFailures;
  }

  add(
    backlog: readonly PlaygroundTraceEvent[],
    onEvent: PlaygroundSubscribeOptions['onEvent'],
  ): PlaygroundSubscriptionEntry {
    const admitted = backlog.length <= this.#maximumQueue;
    const subscription: PlaygroundSubscriptionEntry = {
      active: admitted,
      closed: !admitted,
      delivery: Promise.resolve(),
      draining: false,
      onEvent,
      queue: admitted ? [...backlog] : [],
    };
    if (admitted) {
      this.#entries.add(subscription);
      this.#drain(subscription);
    }
    return subscription;
  }

  entries(): readonly PlaygroundSubscriptionEntry[] {
    return Object.freeze([...this.#entries]);
  }

  publish(event: PlaygroundTraceEvent): void {
    for (const subscription of [...this.#entries]) {
      if (!subscription.active) continue;
      if (subscription.queue.length >= this.#maximumQueue) {
        this.deactivate(subscription);
        continue;
      }
      subscription.queue.push(event);
      this.#drain(subscription);
    }
  }

  async drain(subscriptions: readonly PlaygroundSubscriptionEntry[] = this.entries()): Promise<void> {
    for (const subscription of subscriptions) this.#drain(subscription);
    const settled = await Promise.allSettled(subscriptions.map((subscription) => subscription.delivery));
    for (const result of settled) {
      if (result.status === 'rejected') this.#recordFailure(result.reason);
    }
  }

  deactivate(subscription: PlaygroundSubscriptionEntry): void {
    subscription.active = false;
    subscription.closed = true;
    subscription.queue.length = 0;
    this.#entries.delete(subscription);
  }

  async waitFor(subscription: PlaygroundSubscriptionEntry): Promise<void> {
    await subscription.delivery;
  }

  #drain(subscription: PlaygroundSubscriptionEntry): void {
    if (!subscription.active || subscription.draining) return;
    subscription.draining = true;
    subscription.delivery = (async () => {
      try {
        while (subscription.active && subscription.queue.length > 0) {
          const event = subscription.queue.shift()!;
          try {
            await subscription.onEvent(snapshotEvent(event));
          } catch (error) {
            this.#recordFailure(error);
            this.deactivate(subscription);
          }
        }
      } finally {
        subscription.draining = false;
        if (subscription.active && subscription.queue.length > 0) this.#drain(subscription);
      }
    })();
    void subscription.delivery.catch((error: unknown) => {
      this.#recordFailure(error);
      this.deactivate(subscription);
    });
  }

  #recordFailure(error: unknown): void {
    this.#cleanupFailures.push(Object.freeze({ message: errorMessage(error), operation: 'subscriber' }));
  }
}
