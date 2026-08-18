import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';

import { isCredentialKey, redactEvalCredentialText } from '../eval/credentials.ts';
import { snapshotStrictJsonValue, type JsonValue } from '../core/strict-json.ts';

export const devLogProducers = Object.freeze([
  'project',
  'build',
  'diagnostic',
  'mcp',
  'hook',
  'eval',
  'playground',
] as const);

export const devLogLevels = Object.freeze(['debug', 'info', 'warning', 'error'] as const);

export type DevLogProducer = (typeof devLogProducers)[number];
export type DevLogLevel = (typeof devLogLevels)[number];
export type DevLogDetails = JsonValue | '[UNAVAILABLE]';

export interface DevLogRecord {
  readonly context: Readonly<Record<string, string>>;
  readonly details: DevLogDetails;
  readonly kind: string;
  readonly level: DevLogLevel;
  readonly occurredAt: string;
  readonly producer: DevLogProducer;
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly summary: string;
}

export interface DevLogReplayGap {
  readonly earliestAvailableSequence: number;
  readonly latestDroppedSequence: number;
  readonly requestedAfterSequence: number;
  readonly type: 'replay.gap';
}

export type DevLogMessage = DevLogRecord | DevLogReplayGap;

export interface DevLogReplay {
  readonly cursor: Readonly<{ readonly afterSequence: number }>;
  readonly gap?: DevLogReplayGap;
  readonly records: readonly DevLogRecord[];
}

export interface DevLogInput {
  readonly context?: Readonly<Record<string, unknown>>;
  readonly details?: unknown;
  readonly kind: string;
  readonly level: DevLogLevel;
  readonly occurredAt?: string;
  readonly producer: DevLogProducer;
  readonly summary: string;
}

/** Small optional sink shared by producer choke points without coupling them to retention or transport. */
export interface DevLogSink {
  log(input: DevLogInput): unknown;
}

export interface DevLogSubscribeOptions {
  readonly afterSequence?: number;
}

/** Returning false releases a slow sink without holding up other listeners. */
export type DevLogListener = (message: DevLogMessage) => boolean | void;

export interface DevLogSubscription {
  close(): void;
  readonly closed: boolean;
}

export interface DevLogServiceOptions {
  readonly encodedHistoryByteLimit?: number;
  readonly now?: () => Date;
  readonly projectRoot: string;
  readonly recordByteLimit?: number;
  readonly recordLimit?: number;
  readonly subscriberByteLimit?: number;
  readonly subscriberRecordLimit?: number;
}

export type DevLogServiceErrorCode = 'DEV_LOG_CURSOR_AHEAD' | 'DEV_LOG_CURSOR_INVALID' | 'DEV_LOG_SERVICE_CLOSED';

export class DevLogServiceError extends Error {
  readonly code: DevLogServiceErrorCode;

  constructor(code: DevLogServiceErrorCode, message: string) {
    super(message);
    this.name = 'DevLogServiceError';
    this.code = code;
  }
}

interface Subscription {
  closed: boolean;
  lastDeliveredSequence: number;
  listener: DevLogListener;
  pending: DevLogRecord[];
  pendingBytes: number;
  replaying: boolean;
}

const defaultEncodedHistoryByteLimit = 2 * 1024 * 1024;
const defaultRecordByteLimit = 64 * 1024;
const defaultRecordLimit = 2_048;
const defaultSubscriberByteLimit = 256 * 1024;
const defaultSubscriberRecordLimit = 128;
const unavailable = '[UNAVAILABLE]' as const;
const redacted = '[REDACTED]';
const safeContextKeys = new Set([
  'buildId',
  'diagnosticCode',
  'epochId',
  'hookId',
  'projectId',
  'runId',
  'sessionId',
  'target',
]);
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const safeKind = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u;
const maxSummaryLength = 2_048;

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
};

const isProducer = (value: unknown): value is DevLogProducer =>
  typeof value === 'string' && (devLogProducers as readonly string[]).includes(value);

const isLevel = (value: unknown): value is DevLogLevel =>
  typeof value === 'string' && (devLogLevels as readonly string[]).includes(value);

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const truncate = (value: string, maximum: number): string => value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

const escapeExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const rootFormsFor = (projectRoot: string): readonly string[] => {
  const forms = new Set<string>();
  for (const candidate of [projectRoot, resolve(projectRoot)]) {
    const normalized = candidate.replaceAll('\\', '/').replace(/\/+$/u, '');
    if (normalized.length > 0) forms.add(normalized);
  }
  return Object.freeze([...forms].sort((left, right) => right.length - left.length));
};

const redactAbsolutePaths = (value: string, roots: readonly string[]): string => {
  let sanitized = redactEvalCredentialText(value);
  for (const root of roots) {
    const escaped = escapeExpression(root);
    sanitized = sanitized
      .replace(new RegExp(`file://${escaped}(?=$|[\\/])`, 'gu'), '<project>')
      .replace(new RegExp(`${escaped}(?=$|[\\/])`, 'gu'), '<project>');
  }
  const absolutePath = /file:\/\/[^\s"'`<>]+|\\\\[^\s"'`<>]+|(?:^|[\s"'`(=:[\]])[A-Za-z]:[\\/][^\s"'`<>]*|(?:^|[\s"'`(=:[\]])[/](?![/])[^\s"'`<>]*/u;
  return absolutePath.test(sanitized) ? redacted : sanitized;
};

const sanitizeJson = (value: JsonValue, roots: readonly string[]): JsonValue => {
  if (typeof value === 'string') return redactAbsolutePaths(value, roots);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => sanitizeJson(entry, roots)));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isCredentialKey(key) ? redacted : sanitizeJson(entry, roots),
  ])));
};

const detailsFor = (value: unknown, roots: readonly string[]): DevLogDetails => {
  if (value === undefined) return Object.freeze({});
  try {
    return sanitizeJson(snapshotStrictJsonValue(value), roots);
  } catch {
    return unavailable;
  }
};

const contextFor = (value: DevLogInput['context']): Readonly<Record<string, string>> => {
  if (value === undefined) return Object.freeze({});
  try {
    const snapshot = snapshotStrictJsonValue(value);
    if (!isRecord(snapshot)) return Object.freeze({});
    const context: Record<string, string> = {};
    for (const [key, entry] of Object.entries(snapshot)) {
      if (safeContextKeys.has(key) && typeof entry === 'string' && safeIdentifier.test(entry)) context[key] = entry;
    }
    return Object.freeze(context);
  } catch {
    return Object.freeze({});
  }
};

const summaryFor = (value: unknown, roots: readonly string[]): string =>
  typeof value === 'string' && value.length > 0 ? truncate(redactAbsolutePaths(value, roots), maxSummaryLength) : unavailable;

/**
 * Bounded, in-memory production diagnostics. Every boundary snapshot is
 * descriptor-safe, redacted, and detached before it can enter retained history.
 */
export class DevLogService {
  readonly #encodedHistoryByteLimit: number;
  readonly #history: DevLogRecord[] = [];
  readonly #now: () => Date;
  readonly #recordByteLimit: number;
  readonly #recordLimit: number;
  readonly #roots: readonly string[];
  readonly #subscriberByteLimit: number;
  readonly #subscriberRecordLimit: number;
  readonly #subscriptions = new Set<Subscription>();
  readonly #undelivered: DevLogRecord[] = [];
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #historyBytes = 0;
  #sequence = 0;
  #dispatching = false;

  constructor(options: DevLogServiceOptions) {
    this.#encodedHistoryByteLimit = positiveInteger(options.encodedHistoryByteLimit ?? defaultEncodedHistoryByteLimit, 'encodedHistoryByteLimit');
    this.#now = options.now ?? (() => new Date());
    this.#recordByteLimit = positiveInteger(options.recordByteLimit ?? defaultRecordByteLimit, 'recordByteLimit');
    this.#recordLimit = positiveInteger(options.recordLimit ?? defaultRecordLimit, 'recordLimit');
    this.#roots = rootFormsFor(options.projectRoot);
    this.#subscriberByteLimit = positiveInteger(options.subscriberByteLimit ?? defaultSubscriberByteLimit, 'subscriberByteLimit');
    this.#subscriberRecordLimit = positiveInteger(options.subscriberRecordLimit ?? defaultSubscriberRecordLimit, 'subscriberRecordLimit');
  }

  get latestSequence(): number {
    return this.#sequence;
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  /** Observability is non-throwing: a malformed producer payload cannot alter its operation. */
  log(input: DevLogInput): DevLogRecord | undefined {
    if (this.#closed || !isProducer(input?.producer) || !isLevel(input?.level) || !safeKind.test(input?.kind ?? '')) return undefined;
    try {
      let record = this.#recordFor(input, detailsFor(input.details, this.#roots), contextFor(input.context));
      if (byteLength(record) > this.#recordByteLimit) {
        record = this.#recordFor(input, unavailable, Object.freeze({}));
      }
      this.#retain(record);
      return record;
    } catch {
      return undefined;
    }
  }

  replay(options: DevLogSubscribeOptions = {}): DevLogReplay {
    this.#assertOpen();
    const afterSequence = this.#afterSequence(options.afterSequence ?? 0);
    const gap = this.#gapFor(afterSequence);
    return Object.freeze({
      cursor: Object.freeze({ afterSequence: this.#sequence }),
      ...(gap === undefined ? {} : { gap }),
      records: Object.freeze(this.#history.filter((record) => record.sequence > afterSequence)),
    });
  }

  subscribe(options: DevLogSubscribeOptions, listener: DevLogListener): DevLogSubscription {
    this.#assertOpen();
    if (typeof listener !== 'function') throw new TypeError('A Dev Log listener is required.');
    const afterSequence = this.#afterSequence(options.afterSequence ?? 0);
    const boundary = this.#sequence;
    const subscription: Subscription = {
      closed: false,
      lastDeliveredSequence: afterSequence,
      listener,
      pending: [],
      pendingBytes: 0,
      replaying: true,
    };
    this.#subscriptions.add(subscription);
    const gap = this.#gapFor(afterSequence);
    if (gap !== undefined) this.#notify(subscription, gap);
    // A replay listener may publish while it is being called. Snapshot the
    // boundary first so retention eviction cannot skip a historical record.
    const replay = this.#history.filter((record) => record.sequence > afterSequence && record.sequence <= boundary);
    for (const record of replay) {
      if (!subscription.closed && record.sequence > afterSequence && record.sequence <= boundary) this.#deliver(subscription, record);
    }
    while (!subscription.closed && subscription.pending.length > 0) {
      const record = subscription.pending.shift();
      if (record !== undefined) {
        subscription.pendingBytes -= byteLength(record);
        this.#deliver(subscription, record);
      }
    }
    subscription.replaying = false;
    return Object.freeze({
      close: () => this.#removeSubscription(subscription),
      get closed(): boolean { return subscription.closed; },
    });
  }

  /** Close is idempotent and publishes its promise before listener cleanup can re-enter it. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = Promise.resolve().then(() => {
      for (const subscription of this.#subscriptions) this.#removeSubscription(subscription);
      this.#undelivered.length = 0;
    });
    return this.#closePromise;
  }

  #recordFor(input: DevLogInput, details: DevLogDetails, context: Readonly<Record<string, string>>): DevLogRecord {
    const occurredAt = typeof input.occurredAt === 'string' && !Number.isNaN(Date.parse(input.occurredAt))
      ? input.occurredAt
      : this.#now().toISOString();
    const record = {
      context,
      details,
      kind: input.kind,
      level: input.level,
      occurredAt,
      producer: input.producer,
      schemaVersion: 1 as const,
      sequence: this.#sequence + 1,
      summary: summaryFor(input.summary, this.#roots),
    } satisfies DevLogRecord;
    return Object.freeze(record);
  }

  #retain(record: DevLogRecord): void {
    this.#sequence = record.sequence;
    this.#history.push(record);
    this.#historyBytes += byteLength(record);
    while (this.#history.length > this.#recordLimit || this.#historyBytes > this.#encodedHistoryByteLimit) {
      const dropped = this.#history.shift();
      if (dropped === undefined) break;
      this.#historyBytes -= byteLength(dropped);
    }
    for (const subscription of this.#subscriptions) {
      if (subscription.replaying) this.#enqueueReplay(subscription, record);
    }
    this.#undelivered.push(record);
    this.#drainLive();
  }

  #afterSequence(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DevLogServiceError('DEV_LOG_CURSOR_INVALID', 'Dev Log cursor must be a non-negative safe integer.');
    }
    if (value > this.#sequence) {
      throw new DevLogServiceError('DEV_LOG_CURSOR_AHEAD', 'Dev Log cursor cannot be ahead of the current log stream.');
    }
    return value;
  }

  #assertOpen(): void {
    if (this.#closed) throw new DevLogServiceError('DEV_LOG_SERVICE_CLOSED', 'Dev Log service is closed.');
  }

  #drainLive(): void {
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#undelivered.length > 0) {
        const record = this.#undelivered.shift();
        if (record === undefined) continue;
        for (const subscription of this.#subscriptions) {
          if (!subscription.replaying) this.#deliver(subscription, record);
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #deliver(subscription: Subscription, record: DevLogRecord): void {
    if (subscription.closed || record.sequence <= subscription.lastDeliveredSequence) return;
    subscription.lastDeliveredSequence = record.sequence;
    this.#notify(subscription, record);
  }

  #enqueueReplay(subscription: Subscription, record: DevLogRecord): void {
    const bytes = byteLength(record);
    if (subscription.pending.length >= this.#subscriberRecordLimit || subscription.pendingBytes + bytes > this.#subscriberByteLimit) {
      this.#removeSubscription(subscription);
      return;
    }
    subscription.pending.push(record);
    subscription.pendingBytes += bytes;
  }

  #gapFor(afterSequence: number): DevLogReplayGap | undefined {
    const earliest = this.#history[0]?.sequence;
    if (earliest === undefined || afterSequence >= earliest - 1) return undefined;
    return Object.freeze({
      earliestAvailableSequence: earliest,
      latestDroppedSequence: earliest - 1,
      requestedAfterSequence: afterSequence,
      type: 'replay.gap' as const,
    });
  }

  #notify(subscription: Subscription, message: DevLogMessage): void {
    try {
      if (subscription.listener(message) === false) this.#removeSubscription(subscription);
    } catch {
      this.#removeSubscription(subscription);
    }
  }

  #removeSubscription(subscription: Subscription): void {
    if (subscription.closed) return;
    subscription.closed = true;
    subscription.pending.length = 0;
    subscription.pendingBytes = 0;
    this.#subscriptions.delete(subscription);
  }
}
