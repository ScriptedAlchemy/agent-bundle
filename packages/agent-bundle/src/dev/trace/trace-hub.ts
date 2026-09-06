import { Buffer } from 'node:buffer';

import { deepFreeze } from '../../core/freeze.ts';
import { snapshotStrictJsonValue, type JsonValue } from '../../core/strict-json.ts';
import { safeDevWireText } from '../logs/dev-log-service.ts';
import {
  isTraceSource,
  type TraceEntry,
  type TraceEntryInput,
  type TraceMessage,
  type TraceReplay,
} from './trace-entry.ts';

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
  readonly encodedHistoryByteLimit?: number;
  readonly entryByteLimit?: number;
  readonly entryLimit?: number;
  readonly now?: () => Date;
  readonly projectRoot: string;
  readonly subscriberByteLimit?: number;
  readonly subscriberEntryLimit?: number;
}

export type TraceHubErrorCode = 'TRACE_CURSOR_AHEAD' | 'TRACE_CURSOR_INVALID' | 'TRACE_HUB_CLOSED';

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
  lastDeliveredSequence: number;
  listener: TraceListener;
  pending: TraceMessage[];
  pendingBytes: number;
  replaying: boolean;
}

const defaultEncodedHistoryByteLimit = 2 * 1024 * 1024;
const defaultEntryByteLimit = 16 * 1024;
const defaultEntryLimit = 4_096;
const defaultSubscriberByteLimit = 256 * 1024;
const defaultSubscriberEntryLimit = 128;
const minimumEntryByteLimit = 256;
const maxSummaryLength = 240;
const unavailable = '[UNAVAILABLE]';
const encodedSizes = new WeakMap<object, number>();

const byteLength = (value: object): number => {
  const cached = encodedSizes.get(value);
  if (cached !== undefined) return cached;
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  encodedSizes.set(value, bytes);
  return bytes;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
};

const dropControlCharacters = (value: string): string => {
  let sanitized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) sanitized += value[index];
  }
  return sanitized;
};

const sanitizeText = (value: string, projectRoot: string): string =>
  safeDevWireText(dropControlCharacters(value), projectRoot);

const sanitizeDetails = (value: JsonValue, projectRoot: string): JsonValue => {
  if (typeof value === 'string') return sanitizeText(value, projectRoot);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => sanitizeDetails(entry, projectRoot)));
  const entries: Array<readonly [string, JsonValue]> = [];
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const sanitizedKey = sanitizeText(key, projectRoot);
    if (keys.has(sanitizedKey)) throw new TypeError('Trace detail keys must remain unique after sanitization.');
    keys.add(sanitizedKey);
    entries.push([sanitizedKey, sanitizeDetails(entry, projectRoot)]);
  }
  return Object.freeze(Object.fromEntries(entries));
};

/**
 * Bounded in-memory trace with cursor replay, shared by every publisher of a
 * dev server and read by `GET /api/trace` and `GET /api/trace/stream`.
 * Entries are deep-frozen on publish and evicted oldest-first past
 * `entryLimit`; a replay that starts before the retained window reports a gap.
 */
export class TraceHub implements TracePublisher {
  readonly #encodedHistoryByteLimit: number;
  readonly #entries: TraceEntry[] = [];
  readonly #entryByteLimit: number;
  readonly #entryLimit: number;
  readonly #now: () => Date;
  readonly #projectRoot: string;
  readonly #subscriberByteLimit: number;
  readonly #subscriberEntryLimit: number;
  readonly #subscriptions = new Set<Subscription>();
  readonly #undelivered: TraceEntry[] = [];
  #closed = false;
  #delivering: Subscription | undefined;
  #dispatching = false;
  #droppedThroughSequence = 0;
  #historyBytes = 0;
  #sequence = 0;
  #undeliveredBytes = 0;
  #undeliveredOverflowed = false;

  constructor(options: TraceHubOptions) {
    this.#encodedHistoryByteLimit = positiveInteger(
      options.encodedHistoryByteLimit ?? defaultEncodedHistoryByteLimit,
      'encodedHistoryByteLimit',
    );
    this.#entryByteLimit = positiveInteger(options.entryByteLimit ?? defaultEntryByteLimit, 'entryByteLimit');
    if (this.#entryByteLimit < minimumEntryByteLimit) {
      throw new RangeError(`entryByteLimit must be at least ${minimumEntryByteLimit} bytes.`);
    }
    this.#entryLimit = positiveInteger(options.entryLimit ?? defaultEntryLimit, 'entryLimit');
    this.#now = options.now ?? (() => new Date());
    this.#projectRoot = options.projectRoot;
    this.#subscriberByteLimit = positiveInteger(
      options.subscriberByteLimit ?? defaultSubscriberByteLimit,
      'subscriberByteLimit',
    );
    this.#subscriberEntryLimit = positiveInteger(
      options.subscriberEntryLimit ?? defaultSubscriberEntryLimit,
      'subscriberEntryLimit',
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  get latestSequence(): number {
    return this.#sequence;
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  publish(input: TraceEntryInput): TraceEntry {
    this.#assertOpen();
    if (!isTraceSource(input.source)) throw new TypeError('Trace source is not recognized.');
    const details = this.#detailsFor(input.details);
    let entry = deepFreeze<TraceEntry>({
      ...input,
      ...(details === undefined ? {} : { details }),
      id: `trc_${this.#sequence + 1}`,
      occurredAt: input.occurredAt ?? this.#now().toISOString(),
      sequence: this.#sequence + 1,
      summary: this.#summaryFor(input.summary),
    });
    if (byteLength(entry) > this.#entryByteLimit && entry.details !== undefined) {
      entry = deepFreeze<TraceEntry>({ ...entry, details: unavailable });
    }
    if (byteLength(entry) > this.#entryByteLimit) {
      throw new RangeError(`Trace entry exceeds ${this.#entryByteLimit} encoded bytes.`);
    }
    this.#retain(entry);
    return entry;
  }

  replay(options: TraceSubscribeOptions = {}): TraceReplay {
    this.#assertOpen();
    const after = this.#afterSequence(options.afterSequence ?? 0);
    const gap = this.#gapFor(after);
    return deepFreeze({
      entries: this.#entries.filter((entry) => entry.sequence > after),
      ...(gap === undefined ? {} : { gap }),
      latestSequence: this.#sequence,
    });
  }

  /** Replays the retained window after `afterSequence`, then delivers live entries in order. */
  subscribe(listener: TraceListener, options: TraceSubscribeOptions = {}): TraceSubscription {
    this.#assertOpen();
    if (typeof listener !== 'function') throw new TypeError('A trace listener is required.');
    const afterSequence = this.#afterSequence(options.afterSequence ?? 0);
    const boundary = this.#sequence;
    const gap = this.#gapFor(afterSequence);
    const replay = this.#entries.filter((entry) => entry.sequence > afterSequence && entry.sequence <= boundary);
    const initial = Object.freeze([...(gap === undefined ? [] : [gap]), ...replay]);
    const subscription: Subscription = {
      closed: false,
      lastDeliveredSequence: afterSequence,
      listener,
      pending: [],
      pendingBytes: 0,
      replaying: true,
    };
    this.#subscriptions.add(subscription);
    for (const message of initial) this.#enqueueReplay(subscription, message);
    while (!subscription.closed && subscription.pending.length > 0) {
      const message = subscription.pending.shift();
      if (message !== undefined) {
        subscription.pendingBytes -= byteLength(message);
        this.#deliver(subscription, message);
      }
    }
    subscription.replaying = false;
    return {
      close: () => this.#removeSubscription(subscription),
      get closed() {
        return subscription.closed;
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of this.#subscriptions) this.#removeSubscription(subscription);
    this.#undelivered.length = 0;
    this.#undeliveredBytes = 0;
  }

  #deliver(subscription: Subscription, message: TraceMessage): void {
    if (subscription.closed) return;
    if ('sequence' in message) {
      if (message.sequence <= subscription.lastDeliveredSequence) return;
      subscription.lastDeliveredSequence = message.sequence;
    }
    const previous = this.#delivering;
    this.#delivering = subscription;
    try {
      if (subscription.listener(message) === false) this.#removeSubscription(subscription);
    } catch {
      this.#removeSubscription(subscription);
    } finally {
      this.#delivering = previous;
    }
  }

  #afterSequence(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TraceHubError('TRACE_CURSOR_INVALID', 'Trace cursor must be a non-negative safe integer.');
    }
    if (value > this.#sequence) {
      throw new TraceHubError('TRACE_CURSOR_AHEAD', `Trace cursor ${value} is ahead of the latest sequence ${this.#sequence}.`);
    }
    return value;
  }

  #assertOpen(): void {
    if (this.#closed) throw new TraceHubError('TRACE_HUB_CLOSED', 'The trace hub is closed.');
  }

  #detailsFor(value: JsonValue | undefined): JsonValue | undefined {
    if (value === undefined) return undefined;
    try {
      return sanitizeDetails(snapshotStrictJsonValue(value), this.#projectRoot);
    } catch {
      return unavailable;
    }
  }

  #drainLive(): void {
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#undelivered.length > 0 || this.#undeliveredOverflowed) {
        while (this.#undelivered.length > 0) {
          const entry = this.#undelivered.shift();
          if (entry === undefined) continue;
          this.#undeliveredBytes -= byteLength(entry);
          for (const subscription of this.#subscriptions) {
            if (!subscription.replaying) this.#deliver(subscription, entry);
          }
        }
        if (this.#undeliveredOverflowed) {
          this.#undeliveredOverflowed = false;
          const recovery = Object.freeze([...this.#entries]);
          const subscriptions = Object.freeze([...this.#subscriptions]);
          const gaps = new Map(subscriptions.map((subscription) => [
            subscription,
            subscription.replaying ? undefined : this.#gapFor(subscription.lastDeliveredSequence),
          ]));
          for (const subscription of subscriptions) {
            if (subscription.replaying || subscription.closed) continue;
            const gap = gaps.get(subscription);
            if (gap !== undefined) this.#deliver(subscription, gap);
            for (const entry of recovery) this.#deliver(subscription, entry);
          }
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #enqueueReplay(subscription: Subscription, message: TraceMessage): void {
    const bytes = byteLength(message);
    if (
      subscription.pending.length >= this.#subscriberEntryLimit
      || subscription.pendingBytes + bytes > this.#subscriberByteLimit
    ) {
      this.#removeSubscription(subscription);
      return;
    }
    subscription.pending.push(message);
    subscription.pendingBytes += bytes;
  }

  #gapFor(afterSequence: number) {
    const firstAvailableSequence = this.#entries[0]?.sequence ?? this.#sequence + 1;
    const latestDroppedSequence = Math.max(this.#droppedThroughSequence, firstAvailableSequence - 1);
    if (afterSequence >= latestDroppedSequence) return undefined;
    return deepFreeze({
      droppedCount: latestDroppedSequence - afterSequence,
      firstAvailableSequence,
      requestedAfterSequence: afterSequence,
      type: 'trace.gap' as const,
    });
  }

  #removeSubscription(subscription: Subscription): void {
    if (subscription.closed) return;
    subscription.closed = true;
    subscription.pending.length = 0;
    subscription.pendingBytes = 0;
    this.#subscriptions.delete(subscription);
  }

  #retain(entry: TraceEntry): void {
    this.#sequence = entry.sequence;
    this.#entries.push(entry);
    this.#historyBytes += byteLength(entry);
    while (this.#entries.length > this.#entryLimit || this.#historyBytes > this.#encodedHistoryByteLimit) {
      const dropped = this.#entries.shift();
      if (dropped === undefined) break;
      this.#historyBytes -= byteLength(dropped);
      this.#droppedThroughSequence = Math.max(this.#droppedThroughSequence, dropped.sequence);
    }
    for (const subscription of this.#subscriptions) {
      if (subscription.replaying) this.#enqueueReplay(subscription, entry);
    }
    const bytes = byteLength(entry);
    if (
      this.#undelivered.length >= this.#subscriberEntryLimit
      || this.#undeliveredBytes + bytes > this.#subscriberByteLimit
    ) {
      this.#undeliveredOverflowed = true;
      if (this.#delivering !== undefined) this.#removeSubscription(this.#delivering);
    } else {
      this.#undelivered.push(entry);
      this.#undeliveredBytes += bytes;
    }
    this.#drainLive();
  }

  #summaryFor(value: string): string {
    if (typeof value !== 'string') throw new TypeError('Trace summary must be a string.');
    const sanitized = sanitizeText(value, this.#projectRoot);
    return sanitized.length <= maxSummaryLength ? sanitized : `${sanitized.slice(0, maxSummaryLength - 1)}…`;
  }
}
