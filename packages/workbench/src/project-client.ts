import type { Invalidation, ProjectEventOf, ProjectStatus } from '../../agent-bundle/src/dev/types.ts';

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

interface ProjectStatusResponse {
  readonly status: ProjectStatus;
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

const readResponse = async <Result>(response: Response): Promise<Result> => {
  if (!response.ok) throw new ProjectClientError(`Workbench request failed with HTTP ${response.status}.`);
  return response.json() as Promise<Result>;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInvalidationReason = (value: unknown): value is Invalidation['reason'] =>
  value === 'initial' || value === 'manual' || value === 'source-change';

const parseEventData = (event: EventSourceMessage): unknown => {
  try {
    return JSON.parse(event.data);
  } catch {
    return undefined;
  }
};

const parseSequence = (event: EventSourceMessage, data: unknown): number | undefined => {
  if (!isRecord(data) || typeof data.sequence !== 'number' || !Number.isSafeInteger(data.sequence) || data.sequence < 0) {
    return undefined;
  }
  if (!/^(0|[1-9]\d*)$/u.test(event.lastEventId)) return undefined;
  const lastEventId = Number(event.lastEventId);
  return Number.isSafeInteger(lastEventId) && lastEventId === data.sequence ? lastEventId : undefined;
};

const normalizePaths = (paths: readonly string[]): readonly string[] => Object.freeze(
  [...new Set(paths)].sort((left, right) => left.localeCompare(right)),
);

const parseSourceChangedEvent = (data: unknown): ProjectEventOf<'source.changed'> | undefined => {
  if (!isRecord(data) || data.type !== 'source.changed' || typeof data.sequence !== 'number' ||
    !Number.isSafeInteger(data.sequence) || data.sequence < 0 || typeof data.occurredAt !== 'string' || !isRecord(data.payload)) {
    return undefined;
  }
  const { payload } = data;
  if (!Array.isArray(payload.paths) || !payload.paths.every((path) => typeof path === 'string') ||
    !isInvalidationReason(payload.reason) || typeof payload.occurredAt !== 'string') {
    return undefined;
  }
  return {
    occurredAt: data.occurredAt,
    payload: {
      occurredAt: payload.occurredAt,
      paths: payload.paths,
      reason: payload.reason,
    },
    sequence: data.sequence,
    type: 'source.changed',
  };
};

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
    const result = await readResponse<ProjectStatusResponse>(response);
    this.#listener?.(result.status);
    return result.status;
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
    return (await readResponse<ProjectStatusResponse>(response)).status;
  }

  async #sessionForMutation(): Promise<ProjectSessionResponse> {
    if (this.#session !== undefined) return this.#session;
    const response = await this.#fetch('/api/project/session');
    const session = await readResponse<ProjectSessionResponse>(response);
    this.#session = Object.freeze({ origin: session.origin, token: session.token });
    return this.#session;
  }

  #onEvent(event: EventSourceMessage): void {
    if (this.#closed) return;
    const data = parseEventData(event);
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
