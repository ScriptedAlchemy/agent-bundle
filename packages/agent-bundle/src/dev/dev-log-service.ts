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

/** Closed, producer-owned wire kinds. A producer cannot smuggle arbitrary text into `kind`. */
export interface DevLogKindMap {
  readonly build: 'artifact.available' | 'build.failed' | 'build.started';
  readonly diagnostic:
    | 'artifact.available.diagnostic'
    | 'artifact.status.diagnostic'
    | 'build.failed.diagnostic'
    | 'build.started.diagnostic'
    | 'invalidation.diagnostic'
    | 'runtime.event.diagnostic'
    | 'source.changed.diagnostic'
    | 'source.status.diagnostic';
  readonly eval: 'eval.run.completed' | 'eval.run.failed' | 'eval.run.started';
  readonly hook: 'hook.simulate.completed' | 'hook.simulate.failed' | 'hook.simulate.started';
  readonly mcp: 'mcp.logging' | 'mcp.stderr' | `mcp.operation.${'failed' | 'started' | 'succeeded'}`;
  readonly playground: 'playground.event.appended';
  readonly project:
    | 'artifact.status'
    | 'dev.shutdown.completed'
    | 'dev.shutdown.started'
    | 'invalidation'
    | 'project.events.replay-gap'
    | 'project.invalid-source'
    | 'project.load'
    | 'project.prepared'
    | 'runtime.event'
    | 'source.changed'
    | 'source.status';
}

export type DevLogKindFor<TProducer extends DevLogProducer> = DevLogKindMap[TProducer];

export interface DevLogRecord {
  readonly context: Readonly<Record<string, string>>;
  readonly details: DevLogDetails;
  readonly kind: DevLogKindFor<DevLogProducer>;
  readonly level: DevLogLevel;
  readonly occurredAt: string;
  readonly producer: DevLogProducer;
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

export type DevLogInputFor<TProducer extends DevLogProducer> = Readonly<{
  readonly context?: Readonly<Record<string, unknown>>;
  readonly details?: unknown;
  readonly kind: DevLogKindFor<TProducer>;
  readonly level: DevLogLevel;
  readonly occurredAt?: string;
  readonly producer: TProducer;
  readonly summary: string;
}>;

export type DevLogInput = {
  readonly [TProducer in DevLogProducer]: DevLogInputFor<TProducer>;
}[DevLogProducer];

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
  pending: DevLogMessage[];
  pendingBytes: number;
  replaying: boolean;
}

const defaultEncodedHistoryByteLimit = 2 * 1024 * 1024;
const defaultRecordByteLimit = 64 * 1024;
const defaultRecordLimit = 2_048;
const defaultSubscriberByteLimit = 256 * 1024;
const defaultSubscriberRecordLimit = 128;
const minimumRecordByteLimit = 256;
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

export const devLogKinds = Object.freeze({
  build: Object.freeze(['artifact.available', 'build.failed', 'build.started'] as const),
  diagnostic: Object.freeze([
    'artifact.available.diagnostic', 'artifact.status.diagnostic', 'build.failed.diagnostic', 'build.started.diagnostic',
    'invalidation.diagnostic', 'runtime.event.diagnostic', 'source.changed.diagnostic', 'source.status.diagnostic',
  ] as const),
  eval: Object.freeze(['eval.run.completed', 'eval.run.failed', 'eval.run.started'] as const),
  hook: Object.freeze(['hook.simulate.completed', 'hook.simulate.failed', 'hook.simulate.started'] as const),
  mcp: Object.freeze(['mcp.logging', 'mcp.stderr', 'mcp.operation.failed', 'mcp.operation.started', 'mcp.operation.succeeded'] as const),
  playground: Object.freeze(['playground.event.appended'] as const),
  project: Object.freeze([
    'artifact.status', 'dev.shutdown.completed', 'dev.shutdown.started', 'invalidation', 'project.events.replay-gap',
    'project.invalid-source', 'project.load', 'project.prepared', 'runtime.event', 'source.changed', 'source.status',
  ] as const),
} satisfies { readonly [TProducer in DevLogProducer]: readonly DevLogKindFor<TProducer>[] });

const isKindFor = <TProducer extends DevLogProducer>(producer: TProducer, value: unknown): value is DevLogKindFor<TProducer> =>
  typeof value === 'string' && (devLogKinds[producer] as readonly string[]).includes(value);

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const truncate = (value: string, maximum: number): string => value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

const hasControlOrSeparators = (value: string): boolean => [...value].some((character) =>
  character === '/' || character === '\\' || character <= '\u001F' || character === '\u007F');

const escapeExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const rootFormsFor = (projectRoot: string): readonly string[] => {
  const forms = new Set<string>();
  for (const candidate of [projectRoot, resolve(projectRoot)]) {
    const normalized = candidate.replaceAll('\\', '/').replace(/\/+$/u, '');
    if (normalized.length > 0) forms.add(normalized);
  }
  return Object.freeze([...forms].sort((left, right) => right.length - left.length));
};

const rootExpression = (root: string): string => escapeExpression(root).replaceAll('/', '[\\\\/]');

const projectPath = (value: string, roots: readonly string[]): string => {
  let sanitized = redactEvalCredentialText(value);
  for (const root of roots) {
    const expression = rootExpression(root);
    const suffix = String.raw`(?:[\\/][^\s,;{}()[\]<>"'\x00-\x1F\x7F]*)*`;
    sanitized = sanitized.replace(new RegExp(String.raw`(?:file:\/\/)?${expression}${suffix}`, 'gu'), (match) => {
      const bare = match.replace(/^file:\/\//u, '').replaceAll('\\', '/');
      return `<project>${bare.slice(root.length)}`;
    });
  }
  return sanitized;
};

const redactAbsolutePaths = (value: string, roots: readonly string[]): string => {
  const sanitized = projectPath(value, roots);
  const withoutProjectPaths = sanitized.replace(/<project>(?:\/[A-Za-z0-9._@+-]+)*/gu, '');
  return hasControlOrSeparators(withoutProjectPaths) || /(?:file:|[A-Za-z]:|\\\\)/iu.test(withoutProjectPaths)
    ? redacted
    : sanitized;
};

/** Shared browser-facing text projection: provider credentials and absolute paths never reach a wire record. */
export const safeDevWireText = (value: string, projectRoot: string): string =>
  redactAbsolutePaths(value, rootFormsFor(projectRoot));

const sanitizeJson = (value: JsonValue, roots: readonly string[]): JsonValue => {
  if (typeof value === 'string') return redactAbsolutePaths(value, roots);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => sanitizeJson(entry, roots)));
  const entries = Object.entries(value);
  if (entries.some(([key]) => isCredentialKey(key) || redactEvalCredentialText(key) !== key || hasControlOrSeparators(key))) {
    throw new TypeError('Dev Log detail keys must be safe non-credential names.');
  }
  return Object.freeze(Object.fromEntries(entries.map(([key, entry]) => [key, sanitizeJson(entry, roots)])));
};

const detailsFor = (value: unknown, roots: readonly string[]): DevLogDetails => {
  if (value === undefined) return Object.freeze({});
  try {
    return sanitizeJson(snapshotStrictJsonValue(value), roots);
  } catch {
    return unavailable;
  }
};

const contextFor = (value: unknown): Readonly<Record<string, string>> => {
  if (value === undefined) return Object.freeze({});
  try {
    const snapshot = snapshotStrictJsonValue(value);
    if (!isRecord(snapshot)) return Object.freeze({});
    const context: Record<string, string> = {};
    for (const [key, entry] of Object.entries(snapshot)) {
      if (
        safeContextKeys.has(key) && typeof entry === 'string' && safeIdentifier.test(entry)
        && redactEvalCredentialText(entry) === entry && !hasControlOrSeparators(entry)
      ) context[key] = entry;
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
  #delivering: Subscription | undefined;
  #droppedThroughSequence = 0;
  #historyBytes = 0;
  #sequence = 0;
  #dispatching = false;
  #undeliveredBytes = 0;
  #undeliveredOverflowed = false;

  constructor(options: DevLogServiceOptions) {
    this.#encodedHistoryByteLimit = positiveInteger(options.encodedHistoryByteLimit ?? defaultEncodedHistoryByteLimit, 'encodedHistoryByteLimit');
    this.#now = options.now ?? (() => new Date());
    this.#recordByteLimit = positiveInteger(options.recordByteLimit ?? defaultRecordByteLimit, 'recordByteLimit');
    if (this.#recordByteLimit < minimumRecordByteLimit) {
      throw new RangeError(`recordByteLimit must be at least ${minimumRecordByteLimit} bytes.`);
    }
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
    try {
      if (this.#closed) return undefined;
      // Snapshot the complete envelope before reading any producer-controlled field.
      const snapshot = snapshotStrictJsonValue(input);
      if (!isRecord(snapshot)) return undefined;
      const producer = snapshot.producer;
      if (!isProducer(producer) || !isLevel(snapshot.level) || !isKindFor(producer, snapshot.kind)) return undefined;
      const normalized = Object.freeze({
        ...(snapshot.context === undefined ? {} : { context: snapshot.context }),
        ...(snapshot.details === undefined ? {} : { details: snapshot.details }),
        kind: snapshot.kind,
        level: snapshot.level,
        ...(snapshot.occurredAt === undefined ? {} : { occurredAt: snapshot.occurredAt }),
        producer,
        summary: snapshot.summary,
      }) as DevLogInput;
      let record = this.#recordFor(normalized, detailsFor(normalized.details, this.#roots), contextFor(normalized.context));
      if (byteLength(record) > this.#recordByteLimit) {
        record = this.#fallbackRecord(normalized);
      }
      if (byteLength(record) > this.#recordByteLimit) return undefined;
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
    const gap = this.#gapFor(afterSequence);
    const replay = this.#history.filter((record) => record.sequence > afterSequence && record.sequence <= boundary);
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
    // The full replay/gap snapshot is installed before the first callback. A
    // reentrant producer is therefore appended behind, never between, replay.
    for (const message of initial) this.#enqueueReplay(subscription, message);
    while (!subscription.closed && subscription.pending.length > 0) {
      const message = subscription.pending.shift();
      if (message !== undefined) {
        subscription.pendingBytes -= byteLength(message);
        this.#deliver(subscription, message);
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
      ? new Date(input.occurredAt).toISOString()
      : this.#now().toISOString();
    const record = {
      context,
      details,
      kind: input.kind,
      level: input.level,
      occurredAt,
      producer: input.producer,
      sequence: this.#sequence + 1,
      summary: summaryFor(input.summary, this.#roots),
    } satisfies DevLogRecord;
    return Object.freeze(record);
  }

  #fallbackRecord(input: DevLogInput): DevLogRecord {
    return this.#recordFor(Object.freeze({ ...input, summary: unavailable }) as DevLogInput, unavailable, Object.freeze({}));
  }

  #retain(record: DevLogRecord): void {
    this.#sequence = record.sequence;
    this.#history.push(record);
    this.#historyBytes += byteLength(record);
    while (this.#history.length > this.#recordLimit || this.#historyBytes > this.#encodedHistoryByteLimit) {
      const dropped = this.#history.shift();
      if (dropped === undefined) break;
      this.#historyBytes -= byteLength(dropped);
      this.#droppedThroughSequence = Math.max(this.#droppedThroughSequence, dropped.sequence);
    }
    for (const subscription of this.#subscriptions) {
      if (subscription.replaying) this.#enqueueReplay(subscription, record);
    }
    const bytes = byteLength(record);
    if (
      this.#undelivered.length >= this.#subscriberRecordLimit
      || this.#undeliveredBytes + bytes > this.#subscriberByteLimit
    ) {
      this.#undeliveredOverflowed = true;
      if (this.#delivering !== undefined) this.#removeSubscription(this.#delivering);
    } else {
      this.#undelivered.push(record);
      this.#undeliveredBytes += bytes;
    }
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
      while (this.#undelivered.length > 0 || this.#undeliveredOverflowed) {
        while (this.#undelivered.length > 0) {
          const record = this.#undelivered.shift();
          if (record === undefined) continue;
          this.#undeliveredBytes -= byteLength(record);
          for (const subscription of this.#subscriptions) {
            if (!subscription.replaying) this.#deliver(subscription, record);
          }
        }
        if (this.#undeliveredOverflowed) {
          this.#undeliveredOverflowed = false;
          // Snapshot both gap and retained tail before invoking a listener: a
          // listener may publish and evict history, but cannot mutate this pass.
          const recovery = Object.freeze([...this.#history]);
          const subscriptions = Object.freeze([...this.#subscriptions]);
          const recoveryGaps = new Map<Subscription, DevLogReplayGap | undefined>(subscriptions.map((subscription) => [
            subscription,
            subscription.replaying ? undefined : this.#gapFor(subscription.lastDeliveredSequence),
          ]));
          for (const subscription of subscriptions) {
            if (subscription.replaying || subscription.closed) continue;
            const gap = recoveryGaps.get(subscription);
            if (gap !== undefined) this.#deliver(subscription, gap);
            for (const record of recovery) this.#deliver(subscription, record);
          }
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #deliver(subscription: Subscription, message: DevLogMessage): void {
    if (subscription.closed) return;
    if ('sequence' in message) {
      if (message.sequence <= subscription.lastDeliveredSequence) return;
      subscription.lastDeliveredSequence = message.sequence;
    }
    const previous = this.#delivering;
    this.#delivering = subscription;
    try { this.#notify(subscription, message); }
    finally { this.#delivering = previous; }
  }

  #enqueueReplay(subscription: Subscription, message: DevLogMessage): void {
    const bytes = byteLength(message);
    if (subscription.pending.length >= this.#subscriberRecordLimit || subscription.pendingBytes + bytes > this.#subscriberByteLimit) {
      this.#removeSubscription(subscription);
      return;
    }
    subscription.pending.push(message);
    subscription.pendingBytes += bytes;
  }

  #gapFor(afterSequence: number): DevLogReplayGap | undefined {
    const earliest = this.#history[0]?.sequence;
    const latestDroppedSequence = Math.max(this.#droppedThroughSequence, (earliest ?? this.#sequence + 1) - 1);
    if (afterSequence >= latestDroppedSequence) return undefined;
    return Object.freeze({
      earliestAvailableSequence: earliest ?? this.#sequence + 1,
      latestDroppedSequence,
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
