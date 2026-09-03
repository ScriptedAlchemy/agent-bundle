import { z } from 'zod';

import type { Diagnostic } from '../../agent-bundle/src/contracts/diagnostics.ts';
import { exactKeys, isRecord } from './client-helpers.ts';
import {
  freezeJsonValue,
  type ArtifactEpoch,
  type ArtifactStatus,
  type BuildAttempt,
  type BuildStatus,
  type DevContractStatusEvent,
  type HostAdoptionStatus,
  type Invalidation,
  type ProjectEvent,
  type ProjectEventOf,
  type ProjectEventMessage,
  type ProjectReplayGap,
  type ProjectStatus,
  type SourceStatus,
} from '../../agent-bundle/src/contracts/project.ts';
import { ForegroundRouteClient, ForegroundRouteClientError } from './mcp/mcp-route-client.ts';

export interface EventSourceMessage {
  readonly data: string;
  readonly lastEventId: string;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: EventSourceMessage) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;
export type ProjectClientErrorListener = (reason: unknown) => void;
export type ProjectEventListener = (event: ProjectEventMessage) => void;

export interface ProjectActivitySnapshot {
  readonly changedFiles: readonly string[];
}

export type ProjectActivityListener = (activity: ProjectActivitySnapshot) => void;

export type ProjectConnectionPhase = 'connected' | 'connecting' | 'unavailable';
export interface ProjectConnectionState {
  readonly generation?: number;
  readonly instanceId?: string;
  readonly state: ProjectConnectionPhase;
}
export type ProjectConnectionListener = (connection: ProjectConnectionState) => void;

export interface ProjectClientOptions {
  readonly beforeInstanceChange?: () => Promise<void>;
  readonly events?: EventSourceFactory;
  readonly fetch?: typeof fetch;
  /** Reuses Workbench's memory-only foreground authentication authority. */
  readonly foreground?: ForegroundRouteClient;
  readonly retryDelay?: (milliseconds: number) => Promise<void>;
}

interface ProjectStatusResponse {
  readonly status: ProjectStatus;
}

interface QueuedProjectEvent {
  readonly event: ProjectEventMessage;
  readonly sequence: number | undefined;
}

export class ProjectClientError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ProjectClientError';
    this.code = code;
  }
}

const projectEventTypes = [
  'artifact.available',
  'artifact.status',
  'build.failed',
  'build.started',
  'dev.contract.status',
  'dev.host.sync',
  'invalidation',
  'replay.gap',
  'runtime.event',
  'source.changed',
  'source.status',
] as const;

const browserEvents: EventSourceFactory = (url) => new EventSource(url);
const retryDelay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const retryDelayMilliseconds = 250;

const hasExactKeys: (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => boolean = exactKeys;

export const diagnosticSchema: z.ZodType<Diagnostic> = z.strictObject({
  code: z.string(),
  generatedPath: z.string().optional(),
  message: z.string(),
  recovery: z.string().optional(),
  severity: z.enum(['error', 'info', 'warning']),
  sourcePath: z.string().optional(),
  target: z.string().optional(),
});

const diagnosticSummarySchema = z.strictObject({
  errors: z.number().int().nonnegative(),
  infos: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});

const artifactEpochSchema: z.ZodType<ArtifactEpoch> = z.strictObject({
  configDigest: z.string(),
  createdAt: z.string(),
  diagnostics: diagnosticSummarySchema,
  id: z.string(),
  manifestPath: z.string(),
  modelDigest: z.string(),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  projectRevision: z.string(),
  targetDigests: z.record(z.string(), z.string()),
});

const sourceStatusSchema: z.ZodType<SourceStatus> = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  revision: z.string().optional(),
  state: z.enum(['invalid', 'ready', 'unknown']),
});

const runningBuildAttemptSchema = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  id: z.string(),
  outcome: z.literal('running'),
  sourceRevision: z.string(),
  startedAt: z.string(),
});

const succeededBuildAttemptSchema = z.strictObject({
  completedAt: z.string(),
  diagnostics: z.array(diagnosticSchema),
  id: z.string(),
  outcome: z.literal('succeeded'),
  result: z.strictObject({ epoch: artifactEpochSchema }),
  sourceRevision: z.string(),
  startedAt: z.string(),
});

const failedBuildAttemptSchema = z.strictObject({
  completedAt: z.string(),
  diagnostics: z.tuple([diagnosticSchema]).rest(diagnosticSchema),
  id: z.string(),
  outcome: z.literal('failed'),
  sourceRevision: z.string(),
  startedAt: z.string(),
});

const completedBuildAttemptSchema = z.discriminatedUnion('outcome', [
  failedBuildAttemptSchema,
  succeededBuildAttemptSchema,
]);

const buildAttemptSchema: z.ZodType<BuildAttempt> = z.discriminatedUnion('outcome', [
  failedBuildAttemptSchema,
  runningBuildAttemptSchema,
  succeededBuildAttemptSchema,
]);

const buildStatusSchema: z.ZodType<BuildStatus> = z.discriminatedUnion('state', [
  z.strictObject({
    lastAttempt: completedBuildAttemptSchema.optional(),
    state: z.literal('idle'),
  }),
  z.strictObject({
    activeAttempt: runningBuildAttemptSchema,
    lastAttempt: completedBuildAttemptSchema.optional(),
    state: z.literal('building'),
  }),
  z.strictObject({
    lastAttempt: failedBuildAttemptSchema,
    state: z.literal('failed'),
  }),
]);

const artifactStatusSchema: z.ZodType<ArtifactStatus> = z.discriminatedUnion('state', [
  z.strictObject({
    activeEpoch: artifactEpochSchema,
    currentSourceRevision: z.string(),
    state: z.literal('active'),
  }),
  z.strictObject({
    currentSourceRevision: z.string().optional(),
    state: z.literal('missing'),
  }),
  z.strictObject({
    activeEpoch: artifactEpochSchema,
    currentSourceRevision: z.string(),
    state: z.literal('stale'),
  }),
]);

const devContractStatusSchema: z.ZodType<DevContractStatusEvent> = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  epochId: z.string(),
  failures: z.array(z.strictObject({
    checks: z.array(z.string()),
    routeId: z.string(),
  })),
  state: z.enum(['failed', 'passed']),
  summary: z.string(),
});

const hostAdoptionStatusSchema: z.ZodType<HostAdoptionStatus> = z.strictObject({
  adoptedEpochId: z.string().optional(),
  contracts: devContractStatusSchema.optional(),
  mode: z.enum(['direct', 'gated']),
});

const projectStatusSchema: z.ZodType<ProjectStatus> = z.strictObject({
  artifact: artifactStatusSchema,
  build: buildStatusSchema,
  hostAdoption: hostAdoptionStatusSchema.optional(),
  runtime: z.strictObject({ state: z.literal('configured') }).optional(),
  source: sourceStatusSchema,
});

const projectStatusResponseSchema: z.ZodType<ProjectStatusResponse> = z.strictObject({
  status: projectStatusSchema,
});

const projectStatusResponse = (value: unknown): ProjectStatusResponse => {
  const result = projectStatusResponseSchema.safeParse(value);
  if (!result.success) throw new ProjectClientError('Workbench request returned an invalid response.');
  return Object.freeze(result.data);
};

const projectError = (error: unknown): ProjectClientError | unknown =>
  error instanceof ForegroundRouteClientError
    ? new ProjectClientError(`Workbench request failed with HTTP ${error.status}.`, error.code)
    : error;

const isSequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const parseEventSourceSequence = (lastEventId: string): number | undefined => {
  if (lastEventId.trim() === '') return undefined;
  const sequence = Number(lastEventId);
  return isSequence(sequence) ? sequence : undefined;
};

const malformedProjectEvent = (): never => {
  throw new ProjectClientError('Workbench received a malformed project event.');
};

const parseProjectEvent = (
  expectedType: (typeof projectEventTypes)[number],
  frame: EventSourceMessage,
): QueuedProjectEvent => {
  let value: unknown;
  try {
    value = freezeJsonValue(JSON.parse(frame.data));
  } catch {
    return malformedProjectEvent();
  }

  if (!isRecord(value) || value.type !== expectedType) return malformedProjectEvent();

  if (expectedType === 'replay.gap') {
    if (
      parseEventSourceSequence(frame.lastEventId) !== undefined
      || !hasExactKeys(value, ['earliestAvailableSequence', 'latestDroppedSequence', 'requestedAfterSequence', 'type'])
      || !isSequence(value.requestedAfterSequence)
      || !isSequence(value.latestDroppedSequence)
      || !isSequence(value.earliestAvailableSequence)
      || value.latestDroppedSequence < value.requestedAfterSequence
      || value.earliestAvailableSequence <= value.latestDroppedSequence
    ) {
      return malformedProjectEvent();
    }
    return Object.freeze({ event: value as unknown as ProjectReplayGap, sequence: undefined });
  }

  if (
    !hasExactKeys(value, Object.hasOwn(value, 'epochId') ? ['epochId', 'occurredAt', 'payload', 'sequence', 'type'] : ['occurredAt', 'payload', 'sequence', 'type'])
    || !isSequence(value.sequence)
    || parseEventSourceSequence(frame.lastEventId) !== value.sequence
    || typeof value.occurredAt !== 'string'
    || !Object.hasOwn(value, 'payload')
    || !isRecord(value.payload)
    || (Object.hasOwn(value, 'epochId') && typeof value.epochId !== 'string')
  ) {
    return malformedProjectEvent();
  }

  if (expectedType === 'source.changed') {
    const payload = value.payload;
    if (
      !hasExactKeys(payload, ['occurredAt', 'paths', 'reason']) || typeof payload.occurredAt !== 'string' ||
      !Array.isArray(payload.paths) || !payload.paths.every((path) => typeof path === 'string') ||
      !['initial', 'manual', 'source-change'].includes(payload.reason as string)
    ) return malformedProjectEvent();
  }

  return Object.freeze({ event: value as ProjectEvent, sequence: value.sequence });
};

const normalizePaths = (paths: readonly string[]): readonly string[] => Object.freeze(
  [...new Set(paths)].sort((left, right) => left.localeCompare(right)),
);

const parseSourceChangedEvent = (data: ProjectEventMessage): ProjectEventOf<'source.changed'> | undefined =>
  data.type === 'source.changed' ? data : undefined;

const activityFor = (paths: readonly string[]): ProjectActivitySnapshot => Object.freeze({
  changedFiles: normalizePaths(paths),
});

/**
 * Browser-side transport for the W9 foreground routes. Native EventSource forwards
 * its retained Last-Event-ID on transport reconnects; an app-level replacement seeds
 * a fresh source from the last locally acknowledged cursor.
 */
export class ProjectClient {
  readonly #beforeInstanceChange: () => Promise<void>;
  readonly #events: EventSourceFactory;
  readonly #foreground: ForegroundRouteClient;
  #connection: ProjectConnectionState = Object.freeze({ state: 'connecting' });
  readonly #connectionListeners = new Set<ProjectConnectionListener>();
  #closed = false;
  #activity = activityFor([]);
  readonly #activityListeners = new Set<ProjectActivityListener>();
  #eventDrainPromise: Promise<void> | undefined;
  #eventListener: ProjectEventListener | undefined;
  readonly #eventSubscribers = new Set<ProjectEventListener>();
  #eventQueue: QueuedProjectEvent[] = [];
  #eventSource: EventSourceLike | undefined;
  #eventSourceVersion = 0;
  #eventRefreshPromise: Promise<void> | undefined;
  #eventRefreshQueued = false;
  #highestQueuedEventId = -1;
  #lastEventId = 0;
  #lastSourceChangeSequence = -1;
  #errorListener: ProjectClientErrorListener | undefined;
  #listener: ((status: ProjectStatus) => void) | undefined;
  #refreshPromise: Promise<ProjectStatus> | undefined;
  #recoveryVersion = 0;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;
  #statusGeneration = 0;

  constructor(options: ProjectClientOptions = {}) {
    this.#beforeInstanceChange = options.beforeInstanceChange ?? (async () => undefined);
    this.#events = options.events ?? browserEvents;
    this.#foreground = options.foreground ?? new ForegroundRouteClient({ fetch: options.fetch });
    this.#retryDelay = options.retryDelay ?? retryDelay;
  }

  get lastEventId(): number {
    return this.#lastEventId;
  }

  get activity(): ProjectActivitySnapshot {
    return this.#activity;
  }

  get connection(): ProjectConnectionState { return this.#connection; }

  onConnection(listener: ProjectConnectionListener): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  onActivity(listener: ProjectActivityListener): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  subscribeEvents(listener: ProjectEventListener): () => void {
    if (typeof listener !== 'function') throw new ProjectClientError('Workbench event listener is not valid.');
    if (this.#closed) return () => undefined;
    this.#eventSubscribers.add(listener);
    return () => this.#eventSubscribers.delete(listener);
  }

  async connect(
    listener: (status: ProjectStatus) => void,
    onError?: ProjectClientErrorListener,
    onEvent?: ProjectEventListener,
  ): Promise<ProjectStatus> {
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    this.#listener = listener;
    this.#errorListener = onError;
    this.#eventListener = onEvent;
    let snapshot;
    try {
      snapshot = await this.#foreground.sessionSnapshot();
      this.#setConnection({ generation: snapshot.generation, instanceId: snapshot.instanceId, state: 'connecting' });
    } catch (error) {
      const reason = projectError(error);
      if (!this.#closed) {
        this.#setConnection({ state: 'unavailable' });
        this.#reportError(reason);
        this.#startRecovery(this.#eventSourceVersion);
      }
      throw reason;
    }
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    let status: ProjectStatus;
    try {
      status = await this.refresh();
    } catch (error) {
      const reason = projectError(error);
      if (!this.#closed) {
        this.#setConnection({ generation: snapshot.generation, instanceId: snapshot.instanceId, state: 'unavailable' });
        this.#reportError(reason);
        this.#startRecovery(this.#eventSourceVersion);
      }
      throw reason;
    }
    if (this.#closed) return status;
    const eventSource = this.#events('/api/project/events');
    if (this.#closed) {
      eventSource.close();
      return status;
    }
    this.#eventSource?.close();
    this.#eventSource = eventSource;
    const version = ++this.#eventSourceVersion;
    for (const type of projectEventTypes) {
      eventSource.addEventListener(type, (event) => {
        if (version === this.#eventSourceVersion) this.#onEvent(eventSource, type, event);
      });
    }
    eventSource.addEventListener('error', () => {
      if (!this.#closed && eventSource === this.#eventSource && version === this.#eventSourceVersion) {
        this.#statusGeneration += 1;
        this.#eventRefreshQueued = false;
        eventSource.close();
        this.#eventSource = undefined;
        this.#setConnection({ ...this.#connection, state: 'unavailable' });
        this.#reportError(new ProjectClientError('Foreground project event stream disconnected.'));
        this.#startRecovery(version);
      }
    });
    eventSource.addEventListener('open', () => {
      if (!this.#closed && eventSource === this.#eventSource && version === this.#eventSourceVersion && this.#connection.state !== 'connected') {
        void this.#refreshRecoveredSource(version);
      }
    });
    this.#setConnection({ generation: snapshot.generation, instanceId: snapshot.instanceId, state: 'connected' });
    return status;
  }

  async refresh(): Promise<ProjectStatus> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    const statusGeneration = this.#statusGeneration;
    const operation = this.#readStatus().then((status) => {
      if (!this.#closed && statusGeneration === this.#statusGeneration) this.#listener?.(status);
      return status;
    }).finally(() => {
      this.#refreshPromise = undefined;
    });
    this.#refreshPromise = operation;
    return operation;
  }

  async rebuild(paths: readonly string[] = []): Promise<ProjectStatus> {
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    let result: ProjectStatusResponse;
    try {
      result = projectStatusResponse(await this.#foreground.protectedJson('/api/project/rebuild', {
        body: JSON.stringify({ paths: normalizePaths(paths) }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }));
    } catch (error) {
      throw projectError(error);
    }
    return result.status;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#eventQueue.length = 0;
    this.#eventRefreshQueued = false;
    this.#eventSource?.close();
    this.#eventSource = undefined;
    this.#activityListeners.clear();
    this.#connectionListeners.clear();
    this.#recoveryVersion += 1;
    this.#statusGeneration += 1;
    this.#errorListener = undefined;
    this.#eventListener = undefined;
    this.#eventSubscribers.clear();
    this.#listener = undefined;
  }

  #startRecovery(disconnectedVersion: number): void {
    const recoveryVersion = ++this.#recoveryVersion;
    void this.#recover(disconnectedVersion, recoveryVersion);
  }

  async #recover(disconnectedVersion: number, recoveryVersion: number): Promise<void> {
    while (!this.#closed && recoveryVersion === this.#recoveryVersion) {
      try {
        const previousGeneration = this.#connection.generation;
        const snapshot = await this.#foreground.refreshSession({ beforeAdopt: async () => this.#beforeInstanceChange() });
        if (this.#closed || recoveryVersion !== this.#recoveryVersion) return;
        if (previousGeneration !== undefined && previousGeneration !== snapshot.generation) this.#resetInstanceState();
        const status = await this.#readStatus();
        if (this.#closed || recoveryVersion !== this.#recoveryVersion) return;
        this.#listener?.(status);
        const source = this.#events(this.#eventStreamUrl());
        if (this.#closed || recoveryVersion !== this.#recoveryVersion) { source.close(); return; }
        this.#eventSource = source;
        const version = Math.max(this.#eventSourceVersion + 1, disconnectedVersion + 1);
        this.#eventSourceVersion = version;
        for (const type of projectEventTypes) source.addEventListener(type, (event) => this.#onEvent(source, type, event));
        source.addEventListener('error', () => {
          if (source !== this.#eventSource || version !== this.#eventSourceVersion) return;
          this.#statusGeneration += 1;
          source.close();
          this.#eventSource = undefined;
          this.#setConnection({ generation: snapshot.generation, instanceId: snapshot.instanceId, state: 'unavailable' });
          this.#reportError(new ProjectClientError('Foreground project event stream disconnected.'));
          this.#startRecovery(version);
        });
        source.addEventListener('open', () => { void this.#refreshRecoveredSource(version); });
        this.#setConnection({ generation: snapshot.generation, instanceId: snapshot.instanceId, state: 'connecting' });
        return;
      } catch {
        if (this.#closed || recoveryVersion !== this.#recoveryVersion) return;
        await this.#retryDelay(retryDelayMilliseconds);
      }
    }
  }

  async #refreshRecoveredSource(version: number): Promise<void> {
    const source = this.#eventSource;
    if (this.#closed || version !== this.#eventSourceVersion || source === undefined) return;
    try {
      const status = await this.#readStatus();
      if (this.#closed || version !== this.#eventSourceVersion || source !== this.#eventSource) return;
      this.#listener?.(status);
      const snapshot = await this.#foreground.sessionSnapshot();
      if (version === this.#eventSourceVersion) this.#setConnection({ generation: snapshot.generation, instanceId: snapshot.instanceId, state: 'connected' });
    } catch (error) {
      if (version !== this.#eventSourceVersion || source !== this.#eventSource) return;
      this.#statusGeneration += 1;
      this.#eventSource = undefined;
      source.close();
      this.#setConnection({ ...this.#connection, state: 'unavailable' });
      this.#reportError(error);
      this.#startRecovery(version);
    }
  }

  #resetInstanceState(): void {
    this.#eventQueue.length = 0;
    this.#highestQueuedEventId = -1;
    this.#lastEventId = 0;
    this.#lastSourceChangeSequence = -1;
    this.#activity = activityFor([]);
    for (const listener of this.#activityListeners) listener(this.#activity);
  }

  #setConnection(connection: ProjectConnectionState): void {
    if (this.#connection.state === connection.state && this.#connection.generation === connection.generation && this.#connection.instanceId === connection.instanceId) return;
    this.#connection = Object.freeze(connection);
    for (const listener of this.#connectionListeners) {
      try { listener(this.#connection); } catch { /* observers cannot interrupt recovery */ }
    }
  }

  #eventStreamUrl(): string {
    return this.#lastEventId === 0
      ? '/api/project/events'
      : `/api/project/events?after=${encodeURIComponent(String(this.#lastEventId))}`;
  }

  async #readStatus(): Promise<ProjectStatus> {
    try {
      return projectStatusResponse(await this.#foreground.publicJson('/api/project/status')).status;
    } catch (error) {
      throw projectError(error);
    }
  }

  #onEvent(
    source: EventSourceLike,
    expectedType: (typeof projectEventTypes)[number],
    frame: EventSourceMessage,
  ): void {
    if (this.#closed || source !== this.#eventSource) return;

    let queued: QueuedProjectEvent;
    try {
      queued = parseProjectEvent(expectedType, frame);
    } catch (error) {
      this.#reportError(error);
      this.#enqueueMalformedEvent(frame);
      return;
    }

    if (queued.sequence !== undefined) {
      if (queued.sequence <= this.#highestQueuedEventId) return;
      this.#highestQueuedEventId = queued.sequence;
    }
    this.#eventQueue.push(queued);
    this.#queueEventDrain();
  }

  #enqueueMalformedEvent(frame: EventSourceMessage): void {
    const sequence = parseEventSourceSequence(frame.lastEventId);
    if (sequence !== undefined) {
      if (sequence <= this.#highestQueuedEventId) return;
      this.#highestQueuedEventId = sequence;
    }
    const latestDroppedSequence = sequence ?? this.#lastEventId;
    this.#eventQueue.push(Object.freeze({
      event: Object.freeze({
        earliestAvailableSequence: latestDroppedSequence + 1,
        latestDroppedSequence,
        requestedAfterSequence: this.#lastEventId,
        type: 'replay.gap' as const,
      }),
      sequence: undefined,
    }));
    this.#queueEventDrain();
  }

  #queueEventDrain(): void {
    if (this.#closed || this.#eventDrainPromise !== undefined) return;
    const operation = Promise.resolve().then(async () => {
      while (!this.#closed) {
        const queued = this.#eventQueue.shift();
        if (queued === undefined) return;
        if (queued.event.type === 'replay.gap') {
          this.#publishEvent(queued.event);
          if (this.#closed) return;
          this.#lastEventId = Math.max(this.#lastEventId, queued.event.latestDroppedSequence);
          this.#queueEventRefresh();
          continue;
        }

        if (queued.sequence !== undefined && queued.sequence <= this.#lastEventId) continue;

        let synthesizedGap = false;
        if (queued.sequence !== undefined && queued.sequence > this.#lastEventId + 1) {
          const gap = Object.freeze({
            earliestAvailableSequence: queued.sequence,
            latestDroppedSequence: queued.sequence - 1,
            requestedAfterSequence: this.#lastEventId,
            type: 'replay.gap' as const,
          });
          this.#publishEvent(gap);
          if (this.#closed) return;
          this.#lastEventId = gap.latestDroppedSequence;
          this.#queueEventRefresh();
          synthesizedGap = true;
        }

        this.#publishActivity(queued.event);
        this.#publishEvent(queued.event);
        if (this.#closed) return;
        if (queued.sequence !== undefined) this.#lastEventId = queued.sequence;
        if (queued.event.type !== 'runtime.event' && !synthesizedGap) this.#queueEventRefresh();
      }
    }).finally(() => {
      this.#eventDrainPromise = undefined;
      if (this.#eventQueue.length > 0 && !this.#closed) this.#queueEventDrain();
    });
    this.#eventDrainPromise = operation;
  }

  #publishActivity(event: ProjectEventMessage): void {
    const sourceChanged = parseSourceChangedEvent(event);
    if (sourceChanged === undefined || sourceChanged.sequence <= this.#lastSourceChangeSequence) return;
    this.#lastSourceChangeSequence = sourceChanged.sequence;
    this.#activity = activityFor(sourceChanged.payload.paths);
    for (const listener of this.#activityListeners) {
      try {
        listener(this.#activity);
      } catch {
        // Activity observers must not interrupt foreground event delivery.
      }
    }
  }

  #queueEventRefresh(): void {
    if (this.#closed) return;
    this.#eventRefreshQueued = true;
    if (this.#eventRefreshPromise !== undefined) return;
    const operation = this.#refreshEvents().finally(() => {
      this.#eventRefreshPromise = undefined;
      if (this.#eventRefreshQueued && !this.#closed) this.#queueEventRefresh();
    });
    this.#eventRefreshPromise = operation;
  }

  async #refreshEvents(): Promise<void> {
    while (this.#eventRefreshQueued && !this.#closed) {
      this.#eventRefreshQueued = false;
      try {
        await this.refresh();
      } catch (error) {
        this.#eventRefreshQueued = false;
        this.#reportError(error);
        return;
      }
    }
  }

  #reportError(reason: unknown): void {
    if (this.#closed) return;
    try {
      this.#errorListener?.(reason);
    } catch {
      // Consumer callbacks must not reintroduce an unhandled background rejection.
    }
  }

  #publishEvent(event: ProjectEventMessage): void {
    const listeners = [
      ...(this.#eventListener === undefined ? [] : [this.#eventListener]),
      ...this.#eventSubscribers,
    ];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#reportError(error);
      }
    }
  }
}
