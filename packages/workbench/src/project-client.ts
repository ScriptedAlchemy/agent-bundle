import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';

export interface EventSourceMessage {
  readonly data: string;
  readonly lastEventId: string;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: EventSourceMessage) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

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

const parseSequence = (event: EventSourceMessage): number | undefined => {
  const lastEventId = Number(event.lastEventId);
  if (Number.isSafeInteger(lastEventId) && lastEventId >= 0) return lastEventId;
  try {
    const value = JSON.parse(event.data) as { readonly sequence?: unknown };
    return typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence >= 0
      ? value.sequence
      : undefined;
  } catch {
    return undefined;
  }
};

const normalizePaths = (paths: readonly string[]): readonly string[] => Object.freeze(
  [...new Set(paths)].sort((left, right) => left.localeCompare(right)),
);

/**
 * Browser-side transport for the W9 foreground routes. Native EventSource owns
 * reconnects and forwards its retained Last-Event-ID automatically; this client
 * only turns those events into fresh typed status snapshots.
 */
export class ProjectClient {
  readonly #events: EventSourceFactory;
  readonly #fetch: typeof fetch;
  #closed = false;
  #eventSource: EventSourceLike | undefined;
  #lastEventId = 0;
  #listener: ((status: ProjectStatus) => void) | undefined;
  #refreshPromise: Promise<ProjectStatus> | undefined;
  #refreshQueued = false;
  #session: ProjectSessionResponse | undefined;

  constructor(options: ProjectClientOptions = {}) {
    this.#events = options.events ?? browserEvents;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get lastEventId(): number {
    return this.#lastEventId;
  }

  async connect(listener: (status: ProjectStatus) => void): Promise<ProjectStatus> {
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    this.#listener = listener;
    const status = await this.refresh();
    const eventSource = this.#events('/api/project/events');
    this.#eventSource?.close();
    this.#eventSource = eventSource;
    for (const type of projectEventTypes) eventSource.addEventListener(type, (event) => this.#onEvent(event));
    return status;
  }

  async refresh(): Promise<ProjectStatus> {
    if (this.#refreshPromise !== undefined) {
      this.#refreshQueued = true;
      return this.#refreshPromise;
    }
    const operation = this.#readStatus().then((status) => {
      this.#listener?.(status);
      return status;
    }).finally(() => {
      this.#refreshPromise = undefined;
      if (this.#refreshQueued && !this.#closed) {
        this.#refreshQueued = false;
        void this.refresh();
      }
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
    this.#eventSource?.close();
    this.#eventSource = undefined;
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
    const sequence = parseSequence(event);
    if (sequence !== undefined) this.#lastEventId = Math.max(this.#lastEventId, sequence);
    void this.refresh();
  }
}
