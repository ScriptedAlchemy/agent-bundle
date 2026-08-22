import { z } from 'zod';

import type {
  ArtifactEpoch,
  ArtifactStatus,
  BuildAttempt,
  BuildStatus,
  Invalidation,
  JsonObject,
  JsonValue,
  ProjectEventMessage,
  ProjectStatus,
  SourceStatus,
} from '../../agent-bundle/src/dev/types.ts';
import { diagnosticSchema } from './client-helpers.ts';
import { ForegroundSessionAuthority, type ForegroundSessionSnapshot, wait } from './foreground-session.ts';
import { nonnegativeIntegerSchema, positiveIntegerSchema } from './schema-atoms.ts';

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

export interface ProjectActivitySnapshot {
  readonly changedFiles: readonly string[];
}

export type ProjectActivityListener = (activity: ProjectActivitySnapshot) => void;

export interface ProjectClientOptions {
  /** The Workbench-wide authority for the foreground server identity and credentials. */
  readonly authority?: ForegroundSessionAuthority;
  readonly events?: EventSourceFactory;
  readonly fetch?: typeof fetch;
  /** Injectable backoff so foreground recovery can be tested without wall-clock waits. */
  readonly retryDelay?: (milliseconds: number) => Promise<void>;
}

export class ProjectClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectClientError';
  }
}

const projectEventTypes = [
  'artifact.available',
  'artifact.status',
  'build.failed',
  'build.started',
  'invalidation',
  'replay.gap',
  'runtime.event',
  'source.changed',
  'source.status',
] as const;

const browserEvents: EventSourceFactory = (url) => new EventSource(url);
const retryDelay = (milliseconds: number): Promise<void> => wait(milliseconds);
const retryDelayMilliseconds = 250;

const diagnosticSummarySchema = z.strictObject({
  errors: nonnegativeIntegerSchema,
  infos: nonnegativeIntegerSchema,
  warnings: nonnegativeIntegerSchema,
});

const artifactEpochSchema: z.ZodType<ArtifactEpoch> = z.strictObject({
  configDigest: z.string(),
  createdAt: z.string(),
  diagnostics: diagnosticSummarySchema,
  id: z.string(),
  manifestPath: z.string(),
  modelDigest: z.string(),
  projectRevision: z.string(),
  targetDigests: z.record(z.string(), z.string()),
});

const sourceStatusSchema: z.ZodType<SourceStatus> = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
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

const missingArtifactSchema = z.strictObject({
  currentSourceRevision: z.string().optional(),
  state: z.literal('missing'),
});

const activeArtifactSchema = z.strictObject({
  activeEpoch: artifactEpochSchema,
  currentSourceRevision: z.string(),
  state: z.literal('active'),
});

const staleArtifactSchema = z.strictObject({
  activeEpoch: artifactEpochSchema,
  currentSourceRevision: z.string(),
  state: z.literal('stale'),
});

const artifactStatusSchema: z.ZodType<ArtifactStatus> = z.discriminatedUnion('state', [
  activeArtifactSchema,
  missingArtifactSchema,
  staleArtifactSchema,
]);

const invalidationSchema: z.ZodType<Invalidation> = z.strictObject({
  occurredAt: z.string(),
  paths: z.array(z.string()),
  reason: z.enum(['initial', 'manual', 'source-change']),
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.boolean(),
  z.null(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

const runtimeEventSchema = z.strictObject({
  details: jsonObjectSchema.optional(),
  sessionId: z.string(),
  type: z.string(),
});

const eventEnvelopeSchema = z.strictObject({
  epochId: z.string().optional(),
  occurredAt: z.string(),
  sequence: positiveIntegerSchema,
});

const projectEventMessageSchema: z.ZodType<ProjectEventMessage> = z.discriminatedUnion('type', [
  eventEnvelopeSchema.extend({ payload: activeArtifactSchema, type: z.literal('artifact.available') }).extend({ epochId: z.string() }),
  eventEnvelopeSchema.extend({ payload: artifactStatusSchema, type: z.literal('artifact.status') }),
  eventEnvelopeSchema.extend({ payload: failedBuildAttemptSchema, type: z.literal('build.failed') }),
  eventEnvelopeSchema.extend({ payload: runningBuildAttemptSchema, type: z.literal('build.started') }),
  eventEnvelopeSchema.extend({ payload: invalidationSchema, type: z.literal('invalidation') }),
  eventEnvelopeSchema.extend({ payload: runtimeEventSchema, type: z.literal('runtime.event') }).extend({ epochId: z.string() }),
  eventEnvelopeSchema.extend({ payload: invalidationSchema, type: z.literal('source.changed') }),
  eventEnvelopeSchema.extend({ payload: sourceStatusSchema, type: z.literal('source.status') }),
  z.strictObject({
    earliestAvailableSequence: positiveIntegerSchema,
    latestDroppedSequence: nonnegativeIntegerSchema,
    requestedAfterSequence: nonnegativeIntegerSchema,
    type: z.literal('replay.gap'),
  }),
]);

const projectStatusSchema: z.ZodType<ProjectStatus> = z.strictObject({
  artifact: artifactStatusSchema,
  build: buildStatusSchema,
  source: sourceStatusSchema,
});

const projectStatusResponseSchema = z.strictObject({ status: projectStatusSchema });

const invalidProjectResponse = (): never => {
  throw new ProjectClientError('Workbench received an invalid foreground project response.');
};

const decode = <Result>(schema: z.ZodType<Result>, value: unknown): Result => {
  const result = schema.safeParse(value);
  return result.success ? result.data : invalidProjectResponse();
};

const readResponse = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new ProjectClientError(`Workbench request failed with HTTP ${response.status}.`);
  return response.json();
};

const parseEventData = (event: EventSourceMessage): ProjectEventMessage | undefined => {
  try {
    const result = projectEventMessageSchema.safeParse(JSON.parse(event.data));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const parseSequence = (event: EventSourceMessage, data: ProjectEventMessage): number | undefined => {
  if (!('sequence' in data)) return undefined;
  if (!/^(0|[1-9]\d*)$/u.test(event.lastEventId)) return undefined;
  const lastEventId = Number(event.lastEventId);
  return Number.isSafeInteger(lastEventId) && lastEventId === data.sequence ? lastEventId : undefined;
};

const normalizePaths = (paths: readonly string[]): readonly string[] => Object.freeze(
  [...new Set(paths)].sort((left, right) => left.localeCompare(right)),
);

const activityFor = (paths: readonly string[]): ProjectActivitySnapshot => Object.freeze({
  changedFiles: normalizePaths(paths),
});

export type ProjectConnectionPhase = 'connected' | 'connecting' | 'unavailable';

/** Immutable foreground identity and stream-health state for the Workbench shell. */
export interface ProjectConnectionState {
  readonly generation?: number;
  readonly instanceId?: string;
  readonly state: ProjectConnectionPhase;
}

export type ProjectConnectionListener = (connection: ProjectConnectionState) => void;

const connectionFor = (
  state: ProjectConnectionPhase,
  identity?: Readonly<{ readonly generation: number; readonly instanceId: string }>,
): ProjectConnectionState => Object.freeze({
  ...(identity === undefined ? {} : { generation: identity.generation, instanceId: identity.instanceId }),
  state,
});

const sameConnection = (left: ProjectConnectionState, right: ProjectConnectionState): boolean =>
  left.generation === right.generation && left.instanceId === right.instanceId && left.state === right.state;

const eventUrl = (snapshot: ForegroundSessionSnapshot): string => new URL('/api/project/events', snapshot.origin).toString();

/**
 * Browser-side transport for the W9 foreground routes. A failed event stream is
 * discarded rather than relying on a native reconnect, so each replacement is
 * bound to a freshly-authoritative foreground instance identity.
 */
export class ProjectClient {
  readonly #authority: ForegroundSessionAuthority;
  readonly #events: EventSourceFactory;
  readonly #fetch: typeof fetch;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;
  #closed = false;
  #activity = activityFor([]);
  readonly #activityListeners = new Set<ProjectActivityListener>();
  #connection = connectionFor('connecting');
  readonly #connectionListeners = new Set<ProjectConnectionListener>();
  #eventSource: EventSourceLike | undefined;
  #eventSourceVersion = 0;
  #eventRefreshPromise: Promise<void> | undefined;
  #eventRefreshQueued = false;
  #lastEventId = 0;
  #lastSourceChangeSequence = -1;
  #errorListener: ProjectClientErrorListener | undefined;
  #listener: ((status: ProjectStatus) => void) | undefined;
  #refreshPromise: Promise<ProjectStatus> | undefined;
  #retryPromise: Promise<void> | undefined;
  #streamOpen = false;

  constructor(options: ProjectClientOptions = {}) {
    this.#events = options.events ?? browserEvents;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#authority = options.authority ?? new ForegroundSessionAuthority({ fetch: this.#fetch });
    this.#retryDelay = options.retryDelay ?? retryDelay;
  }

  get lastEventId(): number {
    return this.#lastEventId;
  }

  get activity(): ProjectActivitySnapshot {
    return this.#activity;
  }

  get connection(): ProjectConnectionState {
    return this.#connection;
  }

  onActivity(listener: ProjectActivityListener): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  onConnection(listener: ProjectConnectionListener): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  async connect(listener: (status: ProjectStatus) => void, onError?: ProjectClientErrorListener): Promise<ProjectStatus> {
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    this.#listener = listener;
    this.#errorListener = onError;
    const version = this.#eventSourceVersion + 1;
    try {
      const snapshot = await this.#authority.snapshot();
      if (this.#closed) return this.#readStatus(snapshot);
      this.#adoptSnapshot(snapshot, 'connecting');
      const status = await this.#readAndPublish(snapshot, version);
      if (!this.#isLifecycleCurrent(version)) return status;
      this.#startEventSource(snapshot, version);
      return status;
    } catch (error) {
      this.#setConnection(connectionFor('unavailable', this.#connectionIdentity()));
      throw error;
    }
  }

  async refresh(): Promise<ProjectStatus> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    const operation = this.#authority.snapshot().then((snapshot) => this.#readAndPublish(snapshot)).finally(() => {
      this.#refreshPromise = undefined;
    });
    this.#refreshPromise = operation;
    return operation;
  }

  async rebuild(paths: readonly string[] = []): Promise<ProjectStatus> {
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    const snapshot = await this.#authority.snapshot();
    const response = await this.#fetch('/api/project/rebuild', {
      body: JSON.stringify({ paths: normalizePaths(paths) }),
      headers: {
        'content-type': 'application/json',
        'x-agent-bundle-session': snapshot.token,
      },
      method: 'POST',
    });
    const status = decode(projectStatusResponseSchema, await readResponse(response)).status;
    if (!this.#closed && !this.#isSnapshotCurrent(snapshot)) {
      throw new ProjectClientError('Foreground project operation was superseded.');
    }
    if (!this.#closed) this.#listener?.(status);
    return status;
  }

  close(): void {
    this.#closed = true;
    this.#eventRefreshQueued = false;
    this.#discardEventSource();
    this.#activityListeners.clear();
    this.#connectionListeners.clear();
    this.#errorListener = undefined;
    this.#listener = undefined;
  }

  async #readStatus(snapshot: ForegroundSessionSnapshot): Promise<ProjectStatus> {
    const response = await this.#fetch('/api/project/status', {
      headers: { 'x-agent-bundle-session': snapshot.token },
    });
    return decode(projectStatusResponseSchema, await readResponse(response)).status;
  }

  async #readAndPublish(snapshot: ForegroundSessionSnapshot, version?: number): Promise<ProjectStatus> {
    const status = await this.#readStatus(snapshot);
    if (!this.#closed && !this.#isSnapshotCurrent(snapshot)) {
      throw new ProjectClientError('Foreground project status was superseded.');
    }
    if (!this.#closed && (version === undefined || this.#isLifecycleCurrent(version))) this.#listener?.(status);
    return status;
  }

  #onEvent(event: EventSourceMessage, version: number): void {
    if (!this.#isVersionCurrent(version)) return;
    const data = parseEventData(event);
    if (data === undefined) return;
    const sequence = parseSequence(event, data);
    const sourceChanged = data.type === 'source.changed' ? data : undefined;
    if (sequence !== undefined && sourceChanged !== undefined && sourceChanged.sequence === sequence && sourceChanged.sequence > this.#lastSourceChangeSequence) {
      this.#lastSourceChangeSequence = sourceChanged.sequence;
      this.#activity = activityFor(sourceChanged.payload.paths);
      for (const listener of this.#activityListeners) {
        try {
          listener(this.#activity);
        } catch {
          // Activity observers must not interrupt the foreground status refresh.
        }
      }
    }
    if (sequence !== undefined) this.#lastEventId = Math.max(this.#lastEventId, sequence);
    this.#queueEventRefresh(version);
  }

  #queueEventRefresh(version: number): void {
    if (!this.#isVersionCurrent(version)) return;
    this.#eventRefreshQueued = true;
    if (this.#eventRefreshPromise !== undefined) return;
    const refresh = this.#refreshEvents(version);
    const operation = refresh.finally(() => {
      if (this.#eventRefreshPromise !== operation) return;
      this.#eventRefreshPromise = undefined;
      if (this.#eventRefreshQueued && this.#isVersionCurrent(version)) this.#queueEventRefresh(version);
    });
    this.#eventRefreshPromise = operation;
  }

  async #refreshEvents(version: number): Promise<void> {
    while (this.#eventRefreshQueued && this.#isVersionCurrent(version)) {
      this.#eventRefreshQueued = false;
      try {
        const snapshot = await this.#authority.snapshot();
        await this.#readAndPublish(snapshot, version);
        if (this.#streamOpen && this.#isVersionCurrent(version)) this.#setConnection(connectionFor('connected', snapshot));
      } catch (error) {
        this.#eventRefreshQueued = false;
        if (!this.#isVersionCurrent(version)) return;
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

  #startEventSource(snapshot: ForegroundSessionSnapshot, version: number): void {
    const eventSource = this.#events(eventUrl(snapshot));
    if (this.#closed || version <= this.#eventSourceVersion) {
      eventSource.close();
      return;
    }
    this.#discardEventSource();
    this.#eventSource = eventSource;
    this.#eventSourceVersion = version;
    this.#streamOpen = false;
    for (const type of projectEventTypes) eventSource.addEventListener(type, (event) => this.#onEvent(event, version));
    eventSource.addEventListener('error', () => this.#onEventSourceError(eventSource, version));
    eventSource.addEventListener('open', () => this.#onEventSourceOpen(version));
  }

  #onEventSourceOpen(version: number): void {
    if (!this.#isVersionCurrent(version)) return;
    this.#streamOpen = true;
    this.#queueEventRefresh(version);
  }

  #onEventSourceError(eventSource: EventSourceLike, version: number): void {
    if (!this.#isVersionCurrent(version) || this.#eventSource !== eventSource) return;
    this.#eventRefreshQueued = false;
    this.#eventRefreshPromise = undefined;
    this.#discardEventSource();
    this.#setConnection(connectionFor('unavailable', this.#connectionIdentity()));
    this.#reportError(new ProjectClientError('Foreground project event stream disconnected.'));
    this.#startRecovery(version);
  }

  #startRecovery(disconnectedVersion: number): void {
    if (this.#retryPromise !== undefined) return;
    const operation = this.#recover(disconnectedVersion).finally(() => {
      if (this.#retryPromise === operation) this.#retryPromise = undefined;
    });
    this.#retryPromise = operation;
  }

  async #recover(disconnectedVersion: number): Promise<void> {
    while (!this.#closed && this.#eventSourceVersion === disconnectedVersion + 1) {
      try {
        const snapshot = await this.#authority.refresh();
        if (this.#closed || this.#eventSourceVersion !== disconnectedVersion + 1) return;
        this.#adoptSnapshot(snapshot, 'unavailable');
        const nextVersion = this.#eventSourceVersion + 1;
        await this.#readAndPublish(snapshot, nextVersion);
        if (this.#closed || this.#eventSourceVersion !== disconnectedVersion + 1) return;
        this.#startEventSource(snapshot, nextVersion);
        return;
      } catch {
        if (this.#closed || this.#eventSourceVersion !== disconnectedVersion + 1) return;
        await this.#retryDelay(retryDelayMilliseconds);
      }
    }
  }

  #adoptSnapshot(snapshot: ForegroundSessionSnapshot, state: ProjectConnectionPhase): void {
    const previous = this.#connection;
    if (previous.generation !== undefined && previous.generation !== snapshot.generation) this.#resetInstanceState();
    this.#setConnection(connectionFor(state, snapshot));
  }

  #connectionIdentity(): Readonly<{ readonly generation: number; readonly instanceId: string }> | undefined {
    const { generation, instanceId } = this.#connection;
    if (generation === undefined || instanceId === undefined) return undefined;
    return { generation, instanceId };
  }

  #discardEventSource(): void {
    this.#eventSource?.close();
    this.#eventSource = undefined;
    this.#eventSourceVersion += 1;
    this.#streamOpen = false;
  }

  #isVersionCurrent(version: number): boolean {
    return !this.#closed && this.#eventSource !== undefined && this.#eventSourceVersion === version;
  }

  #isLifecycleCurrent(version: number): boolean {
    return !this.#closed && (this.#eventSourceVersion === version || this.#eventSourceVersion + 1 === version);
  }

  #isSnapshotCurrent(snapshot: ForegroundSessionSnapshot): boolean {
    return this.#connection.generation === undefined ||
      this.#connection.generation === snapshot.generation && this.#connection.instanceId === snapshot.instanceId;
  }

  #resetInstanceState(): void {
    this.#lastEventId = 0;
    this.#lastSourceChangeSequence = -1;
    this.#activity = activityFor([]);
    for (const listener of this.#activityListeners) {
      try {
        listener(this.#activity);
      } catch {
        // Activity observers must not interrupt foreground recovery.
      }
    }
  }

  #setConnection(connection: ProjectConnectionState): void {
    if (sameConnection(this.#connection, connection)) return;
    this.#connection = connection;
    for (const listener of this.#connectionListeners) {
      try {
        listener(connection);
      } catch {
        // Connection observers must not interrupt foreground recovery.
      }
    }
  }
}
