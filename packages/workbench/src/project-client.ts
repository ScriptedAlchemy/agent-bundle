import { z } from 'zod';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type {
  ArtifactEpoch,
  ArtifactStatus,
  BuildAttempt,
  BuildStatus,
  Invalidation,
  JsonObject,
  JsonValue,
  ProjectEventMessage,
  ProjectEventOf,
  ProjectStatus,
  SourceStatus,
} from '../../agent-bundle/src/dev/types.ts';
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
  readonly events?: EventSourceFactory;
  readonly fetch?: typeof fetch;
}

interface ProjectSessionResponse {
  readonly origin: string;
  readonly token: string;
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

const diagnosticSchema: z.ZodType<Diagnostic> = z.strictObject({
  code: z.string(),
  generatedPath: z.string().optional(),
  message: z.string(),
  recovery: z.string().optional(),
  severity: z.enum(['error', 'info', 'warning']),
  sourcePath: z.string().optional(),
  target: z.string().optional(),
});

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
const projectSessionResponseSchema: z.ZodType<ProjectSessionResponse> = z.strictObject({ origin: z.string(), token: z.string() });

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

const parseSourceChangedEvent = (data: ProjectEventMessage): ProjectEventOf<'source.changed'> | undefined =>
  data.type === 'source.changed' ? data : undefined;

const activityFor = (paths: readonly string[]): ProjectActivitySnapshot => Object.freeze({
  changedFiles: normalizePaths(paths),
});

/**
 * Browser-side transport for the W9 foreground routes. Native EventSource owns
 * reconnects and forwards its retained Last-Event-ID automatically; this client
 * only turns those events into fresh typed status snapshots.
 */
export class ProjectClient {
  readonly #events: EventSourceFactory;
  readonly #fetch: typeof fetch;
  #closed = false;
  #activity = activityFor([]);
  readonly #activityListeners = new Set<ProjectActivityListener>();
  #eventSource: EventSourceLike | undefined;
  #eventRefreshPromise: Promise<void> | undefined;
  #eventRefreshQueued = false;
  #lastEventId = 0;
  #lastSourceChangeSequence = -1;
  #errorListener: ProjectClientErrorListener | undefined;
  #listener: ((status: ProjectStatus) => void) | undefined;
  #refreshPromise: Promise<ProjectStatus> | undefined;
  #session: ProjectSessionResponse | undefined;

  constructor(options: ProjectClientOptions = {}) {
    this.#events = options.events ?? browserEvents;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get lastEventId(): number {
    return this.#lastEventId;
  }

  get activity(): ProjectActivitySnapshot {
    return this.#activity;
  }

  onActivity(listener: ProjectActivityListener): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  async connect(listener: (status: ProjectStatus) => void, onError?: ProjectClientErrorListener): Promise<ProjectStatus> {
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    this.#listener = listener;
    this.#errorListener = onError;
    const status = await this.refresh();
    if (this.#closed) return status;
    const eventSource = this.#events('/api/project/events');
    if (this.#closed) {
      eventSource.close();
      return status;
    }
    this.#eventSource?.close();
    this.#eventSource = eventSource;
    for (const type of projectEventTypes) eventSource.addEventListener(type, (event) => this.#onEvent(event));
    eventSource.addEventListener('error', () => this.#reportError(new ProjectClientError('Foreground project event stream disconnected.')));
    eventSource.addEventListener('open', () => this.#queueEventRefresh());
    return status;
  }

  async refresh(): Promise<ProjectStatus> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    const operation = this.#readStatus().then((status) => {
      if (!this.#closed) this.#listener?.(status);
      return status;
    }).finally(() => {
      this.#refreshPromise = undefined;
    });
    this.#refreshPromise = operation;
    return operation;
  }

  async rebuild(paths: readonly string[] = []): Promise<ProjectStatus> {
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    const session = await this.#sessionForMutation();
    const response = await this.#fetch('/api/project/rebuild', {
      body: JSON.stringify({ paths: normalizePaths(paths) }),
      headers: {
        'content-type': 'application/json',
        'x-agent-bundle-session': session.token,
      },
      method: 'POST',
    });
    const status = decode(projectStatusResponseSchema, await readResponse(response)).status;
    this.#listener?.(status);
    return status;
  }

  close(): void {
    this.#closed = true;
    this.#eventRefreshQueued = false;
    this.#eventSource?.close();
    this.#eventSource = undefined;
    this.#activityListeners.clear();
    this.#errorListener = undefined;
    this.#listener = undefined;
  }

  async #readStatus(): Promise<ProjectStatus> {
    const response = await this.#fetch('/api/project/status');
    return decode(projectStatusResponseSchema, await readResponse(response)).status;
  }

  async #sessionForMutation(): Promise<ProjectSessionResponse> {
    if (this.#session !== undefined) return this.#session;
    const response = await this.#fetch('/api/project/session');
    const session = decode(projectSessionResponseSchema, await readResponse(response));
    this.#session = Object.freeze({ origin: session.origin, token: session.token });
    return this.#session;
  }

  #onEvent(event: EventSourceMessage): void {
    if (this.#closed) return;
    const data = parseEventData(event);
    if (data === undefined) return;
    const sequence = parseSequence(event, data);
    const sourceChanged = parseSourceChangedEvent(data);
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
    this.#queueEventRefresh();
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
}
