import { deepFreeze } from '../../core/freeze.ts';
import type { TraceEntry, TraceEntryInput, TraceMessage, TraceReplay } from './trace-entry.ts';

/**
 * The publish-only face every producer receives (`trace?: TracePublisher` in
 * its options). Producers never see retention, subscribers, or transport.
 */
export interface TracePublisher {
  publish(input: TraceEntryInput): TraceEntry;
}

export interface TraceSubscribeOptions {
  readonly afterSequence?: number;
}

/** Returning false releases a slow subscriber without holding up the others. */
export type TraceListener = (message: TraceMessage) => boolean | void;

export interface TraceSubscription {
  close(): void;
  readonly closed: boolean;
}

export interface TraceHubOptions {
  readonly entryLimit?: number;
  readonly now?: () => Date;
}

export type TraceHubErrorCode = 'TRACE_CURSOR_AHEAD' | 'TRACE_HUB_CLOSED';

export class TraceHubError extends Error {
  readonly code: TraceHubErrorCode;

  constructor(code: TraceHubErrorCode, message: string) {
    super(message);
    this.name = 'TraceHubError';
    this.code = code;
  }
}

interface Subscription {
  closed: boolean;
  listener: TraceListener;
}

const defaultEntryLimit = 4_096;
const maxSummaryLength = 240;

/**
 * Bounded in-memory trace with cursor replay, shared by every publisher of a
 * dev server and read by `GET /api/trace` and `GET /api/trace/stream`.
 * Entries are deep-frozen on publish and evicted oldest-first past
 * `entryLimit`; a replay that starts before the retained window reports a gap.
 */
export class TraceHub implements TracePublisher {
  readonly #entries: TraceEntry[] = [];
  readonly #entryLimit: number;
  readonly #now: () => Date;
  readonly #subscriptions = new Set<Subscription>();
  #closed = false;
  #sequence = 0;

  constructor(options: TraceHubOptions = {}) {
    this.#entryLimit = options.entryLimit ?? defaultEntryLimit;
    this.#now = options.now ?? (() => new Date());
  }

  get closed(): boolean {
    return this.#closed;
  }

  get latestSequence(): number {
    return this.#sequence;
  }

  publish(input: TraceEntryInput): TraceEntry {
    if (this.#closed) throw new TraceHubError('TRACE_HUB_CLOSED', 'The trace hub is closed.');
    this.#sequence += 1;
    const entry = deepFreeze<TraceEntry>({
      ...input,
      id: `trc_${this.#sequence}`,
      occurredAt: input.occurredAt ?? this.#now().toISOString(),
      sequence: this.#sequence,
      summary: input.summary.length <= maxSummaryLength ? input.summary : `${input.summary.slice(0, maxSummaryLength - 1)}…`,
    });
    this.#entries.push(entry);
    if (this.#entries.length > this.#entryLimit) this.#entries.splice(0, this.#entries.length - this.#entryLimit);
    for (const subscription of this.#subscriptions) this.#deliver(subscription, entry);
    return entry;
  }

  replay(options: TraceSubscribeOptions = {}): TraceReplay {
    const after = options.afterSequence ?? 0;
    if (after > this.#sequence) {
      throw new TraceHubError('TRACE_CURSOR_AHEAD', `Trace cursor ${after} is ahead of the latest sequence ${this.#sequence}.`);
    }
    const first = this.#entries[0];
    const gap = first !== undefined && after + 1 < first.sequence
      ? deepFreeze({
        droppedCount: first.sequence - after - 1,
        firstAvailableSequence: first.sequence,
        requestedAfterSequence: after,
        type: 'trace.gap' as const,
      })
      : undefined;
    return deepFreeze({
      entries: this.#entries.filter((entry) => entry.sequence > after),
      ...(gap === undefined ? {} : { gap }),
      latestSequence: this.#sequence,
    });
  }

  /** Replays the retained window after `afterSequence`, then delivers live entries in order. */
  subscribe(listener: TraceListener, options: TraceSubscribeOptions = {}): TraceSubscription {
    if (this.#closed) throw new TraceHubError('TRACE_HUB_CLOSED', 'The trace hub is closed.');
    const subscription: Subscription = { closed: false, listener };
    const replay = this.replay(options);
    if (replay.gap !== undefined) this.#deliver(subscription, replay.gap);
    for (const entry of replay.entries) {
      if (subscription.closed) break;
      this.#deliver(subscription, entry);
    }
    if (!subscription.closed) this.#subscriptions.add(subscription);
    return {
      close: () => {
        subscription.closed = true;
        this.#subscriptions.delete(subscription);
      },
      get closed() {
        return subscription.closed;
      },
    };
  }

  close(): void {
    this.#closed = true;
    for (const subscription of this.#subscriptions) subscription.closed = true;
    this.#subscriptions.clear();
  }

  #deliver(subscription: Subscription, message: TraceMessage): void {
    if (subscription.closed) return;
    let keep: boolean | void;
    try {
      keep = subscription.listener(message);
    } catch {
      keep = false;
    }
    if (keep === false) {
      subscription.closed = true;
      this.#subscriptions.delete(subscription);
    }
  }
}
