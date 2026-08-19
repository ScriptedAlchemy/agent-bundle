import type {
  McpSessionBinding,
  McpSessionTraceEntry,
  McpSessionTraceListener,
  McpSessionTraceMessage,
  McpSessionTraceReplay,
  McpSessionTraceReplayGap,
  McpSessionTraceSubscription,
  McpSessionTraceSubscriptionOptions,
} from './mcp-session-protocol.ts';

export type McpSessionTraceSink = (binding: McpSessionBinding, entry: McpSessionTraceEntry) => void;

interface TraceSubscription {
  closed: boolean;
  lastDeliveredSequence: number;
  readonly listener: McpSessionTraceListener;
  readonly pending: McpSessionTraceEntry[];
  replaying: boolean;
}

const maximumRetainedEntries = 512;

/** Owns retained trace history and atomic replay-plus-live delivery for one session. */
export class McpSessionTraceLog {
  readonly #binding: McpSessionBinding;
  readonly #entries: McpSessionTraceEntry[] = [];
  readonly #sink: McpSessionTraceSink | undefined;
  readonly #subscriptions = new Set<TraceSubscription>();
  readonly #undeliveredEntries: McpSessionTraceEntry[] = [];
  #dispatching = false;
  #droppedThroughSequence = 0;
  #sequence = 0;

  constructor(binding: McpSessionBinding, sink?: McpSessionTraceSink) {
    this.#binding = binding;
    this.#sink = sink;
  }

  nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  record(entry: McpSessionTraceEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > maximumRetainedEntries) {
      const dropped = this.#entries.shift();
      if (dropped !== undefined) this.#droppedThroughSequence = dropped.sequence;
    }
    for (const subscription of this.#subscriptions) {
      if (subscription.replaying) subscription.pending.push(entry);
    }
    this.#undeliveredEntries.push(entry);
    this.#drainLiveEntries();
    try {
      this.#sink?.(this.#binding, entry);
    } catch {
      // Diagnostics must never alter an MCP session or expose raw frames.
    }
  }

  replay(afterSequence = 0): McpSessionTraceReplay {
    this.#assertCursor(afterSequence);
    const overflow = afterSequence < this.#droppedThroughSequence
      ? Object.freeze({ afterSequence, droppedThroughSequence: this.#droppedThroughSequence })
      : undefined;
    return Object.freeze({
      entries: Object.freeze(this.#entries.filter((entry) => entry.sequence > afterSequence)),
      ...(overflow === undefined ? {} : { overflow }),
    });
  }

  subscribe(
    options: McpSessionTraceSubscriptionOptions,
    listener: McpSessionTraceListener,
  ): McpSessionTraceSubscription {
    if (typeof listener !== 'function') throw new TypeError('An MCP session trace listener is required.');
    const afterSequence = options.afterSequence ?? 0;
    this.#assertCursor(afterSequence);
    const boundary = this.#sequence;
    const subscription: TraceSubscription = {
      closed: false,
      lastDeliveredSequence: afterSequence,
      listener,
      pending: [],
      replaying: true,
    };
    this.#subscriptions.add(subscription);

    const firstRetained = this.#entries[0]?.sequence;
    const replayEntries = this.#entries.filter((entry) => entry.sequence > afterSequence && entry.sequence <= boundary);
    if (firstRetained !== undefined && afterSequence < firstRetained - 1) {
      this.#deliverGap(subscription, Object.freeze({
        earliestAvailableSequence: firstRetained,
        latestDroppedSequence: firstRetained - 1,
        requestedAfterSequence: afterSequence,
        type: 'replay.gap',
      }));
    }
    for (const entry of replayEntries) this.#deliverEntry(subscription, entry);
    while (!subscription.closed && subscription.pending.length > 0) {
      const entry = subscription.pending.shift();
      if (entry !== undefined) this.#deliverEntry(subscription, entry);
    }
    subscription.replaying = false;

    return Object.freeze({
      unsubscribe: () => this.#removeSubscription(subscription),
    });
  }

  #assertCursor(afterSequence: number): void {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('MCP session trace cursor must be a nonnegative safe integer.');
    }
    if (afterSequence > this.#sequence) {
      throw new RangeError('MCP session trace cursor cannot be ahead of the current trace.');
    }
  }

  #removeSubscription(subscription: TraceSubscription): void {
    subscription.closed = true;
    this.#subscriptions.delete(subscription);
  }

  #notify(subscription: TraceSubscription, message: McpSessionTraceMessage): void {
    try {
      subscription.listener(message);
    } catch {
      this.#removeSubscription(subscription);
    }
  }

  #deliverGap(subscription: TraceSubscription, gap: McpSessionTraceReplayGap): void {
    if (!subscription.closed) this.#notify(subscription, gap);
  }

  #deliverEntry(subscription: TraceSubscription, entry: McpSessionTraceEntry): void {
    if (subscription.closed || entry.sequence <= subscription.lastDeliveredSequence) return;
    subscription.lastDeliveredSequence = entry.sequence;
    this.#notify(subscription, entry);
  }

  #drainLiveEntries(): void {
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#undeliveredEntries.length > 0) {
        const entry = this.#undeliveredEntries.shift();
        if (entry === undefined) continue;
        for (const subscription of this.#subscriptions) {
          if (!subscription.replaying) this.#deliverEntry(subscription, entry);
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }
}
