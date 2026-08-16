import {
  freezeJsonValue,
  type ProjectEvent,
  type ProjectEventMessage,
  type ProjectReplayGap,
  type ProjectStatus,
} from '../../agent-bundle/src/dev/types.ts';
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

export interface ProjectClientOptions {
  readonly events?: EventSourceFactory;
  readonly fetch?: typeof fetch;
  /** Reuses Workbench's memory-only foreground authentication authority. */
  readonly foreground?: ForegroundRouteClient;
}

interface ProjectStatusResponse {
  readonly status: ProjectStatus;
}

interface QueuedProjectEvent {
  readonly event: ProjectEventMessage;
  readonly sequence: number | undefined;
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isProjectStatus = (value: unknown): value is ProjectStatus => isRecord(value);

const projectStatusResponse = (value: unknown): ProjectStatusResponse => {
  if (!isRecord(value) || !Object.hasOwn(value, 'status') || !isProjectStatus(value.status)) {
    throw new ProjectClientError('Workbench request returned an invalid response.');
  }
  return Object.freeze({ status: value.status });
};

const projectError = (error: unknown): ProjectClientError | unknown =>
  error instanceof ForegroundRouteClientError
    ? new ProjectClientError(`Workbench request failed with HTTP ${error.status}.`)
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
    !isSequence(value.sequence)
    || parseEventSourceSequence(frame.lastEventId) !== value.sequence
    || typeof value.occurredAt !== 'string'
    || !Object.hasOwn(value, 'payload')
    || !isRecord(value.payload)
    || (Object.hasOwn(value, 'epochId') && typeof value.epochId !== 'string')
  ) {
    return malformedProjectEvent();
  }

  return Object.freeze({ event: value as ProjectEvent, sequence: value.sequence });
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
  readonly #foreground: ForegroundRouteClient;
  #closed = false;
  #eventDrainPromise: Promise<void> | undefined;
  #eventListener: ProjectEventListener | undefined;
  readonly #eventSubscribers = new Set<ProjectEventListener>();
  #eventQueue: QueuedProjectEvent[] = [];
  #eventSource: EventSourceLike | undefined;
  #eventRefreshPromise: Promise<void> | undefined;
  #eventRefreshQueued = false;
  #highestQueuedEventId = -1;
  #lastEventId = 0;
  #errorListener: ProjectClientErrorListener | undefined;
  #listener: ((status: ProjectStatus) => void) | undefined;
  #refreshPromise: Promise<ProjectStatus> | undefined;

  constructor(options: ProjectClientOptions = {}) {
    this.#events = options.events ?? browserEvents;
    this.#foreground = options.foreground ?? new ForegroundRouteClient({ fetch: options.fetch });
  }

  get lastEventId(): number {
    return this.#lastEventId;
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
    try {
      await this.#foreground.ensureSession();
    } catch (error) {
      throw projectError(error);
    }
    if (this.#closed) throw new ProjectClientError('Workbench client is closed.');
    const status = await this.refresh();
    if (this.#closed) return status;
    const eventSource = this.#events('/api/project/events');
    if (this.#closed) {
      eventSource.close();
      return status;
    }
    this.#eventSource?.close();
    this.#eventSource = eventSource;
    for (const type of projectEventTypes) {
      eventSource.addEventListener(type, (event) => this.#onEvent(eventSource, type, event));
    }
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
    this.#listener?.(result.status);
    return result.status;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#eventQueue.length = 0;
    this.#eventRefreshQueued = false;
    this.#eventSource?.close();
    this.#eventSource = undefined;
    this.#errorListener = undefined;
    this.#eventListener = undefined;
    this.#eventSubscribers.clear();
    this.#listener = undefined;
    this.#foreground.forgetAuthentication();
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
