import { CodedError } from '../core/errors.ts';
import {
  freezeJsonValue,
  freezeProjectEvent,
  type ProjectEvent,
  type ProjectEventMessage,
  type ProjectEventOf,
  type ProjectEventType,
  type ProjectReplayGap,
} from './types.ts';

type EpochScopedProjectEventType = 'artifact.available';

type ProjectEventInputFor<TType extends ProjectEventType> = Readonly<{
  readonly occurredAt?: string;
  readonly payload: ProjectEventOf<TType>['payload'];
  readonly type: TType;
}> &
  (TType extends EpochScopedProjectEventType
    ? Readonly<{ readonly epochId: string }>
    : Readonly<{ readonly epochId?: string }>);

/** Discriminated publish input; each event type selects exactly one payload. */
export type ProjectEventInput = {
  readonly [TType in ProjectEventType]: ProjectEventInputFor<TType>;
}[ProjectEventType];

export interface ProjectEventSubscriptionOptions {
  /** Resume after this event. Omit to replay the retained history. */
  readonly afterSequence?: number;
}

export type ProjectEventListener = (event: ProjectEventMessage) => void;

export interface ProjectEventSubscription {
  unsubscribe(): void;
}

export interface ProjectEventListenerFailure {
  readonly error: unknown;
  readonly event: ProjectEventMessage;
}

export interface ProjectEventHubOptions {
  /** Receives isolated listener failures after the failed subscription is removed. */
  readonly onListenerError?: (failure: ProjectEventListenerFailure) => void;
  readonly now?: () => Date;
  /** Number of published events retained for reconnecting clients. */
  readonly replayLimit?: number;
}

export type ProjectEventHubErrorCode =
  | 'PROJECT_EVENT_CURSOR_AHEAD'
  | 'PROJECT_EVENT_EPOCH_REQUIRED'
  | 'PROJECT_EVENT_PAYLOAD_INVALID'
  | 'PROJECT_EVENT_TYPE_INVALID';

export class ProjectEventHubError extends CodedError<ProjectEventHubErrorCode> {
  constructor(code: ProjectEventHubErrorCode, message: string) {
    super('ProjectEventHubError', code, message);
  }
}

interface Subscription {
  closed: boolean;
  lastDeliveredSequence: number;
  listener: ProjectEventListener;
  pending: ProjectEvent[];
  replaying: boolean;
}

const defaultReplayLimit = 256;
/** Listener failures are observability-only; retain a bounded window so long-lived hubs cannot grow without limit. */
const maxRetainedListenerErrors = 256;
const eventTypes = new Set<ProjectEventType>([
  'source.changed',
  'source.status',
  'invalidation',
  'build.started',
  'build.failed',
  'artifact.available',
  'artifact.status',
  'runtime.event',
]);

const requiresEpoch = (type: ProjectEventType): boolean =>
  type === 'artifact.available';

const ensureReplayLimit = (replayLimit: number): number => {
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 1) {
    throw new RangeError('replayLimit must be a positive safe integer.');
  }

  return replayLimit;
};

const ensureSequence = (sequence: number): number => {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError('afterSequence must be a non-negative safe integer.');
  }

  return sequence;
};

const isProjectEventType = (value: unknown): value is ProjectEventType =>
  typeof value === 'string' && eventTypes.has(value as ProjectEventType);

/**
 * Process-local ordered stream for project state and runtime activity. It has no
 * persistence or transport concerns; callers attach their own browser bridge.
 */
export class ProjectEventHub {
  readonly #history: ProjectEvent[] = [];
  readonly #listenerErrors: ProjectEventListenerFailure[] = [];
  readonly #onListenerError?: (failure: ProjectEventListenerFailure) => void;
  readonly #now: () => Date;
  readonly #replayLimit: number;
  readonly #subscriptions = new Set<Subscription>();
  readonly #undelivered: ProjectEvent[] = [];
  #dispatching = false;
  #sequence = 0;

  constructor(options: ProjectEventHubOptions = {}) {
    this.#onListenerError = options.onListenerError;
    this.#now = options.now ?? (() => new Date());
    this.#replayLimit = ensureReplayLimit(options.replayLimit ?? defaultReplayLimit);
  }

  get latestSequence(): number {
    return this.#sequence;
  }

  get listenerErrors(): readonly ProjectEventListenerFailure[] {
    return Object.freeze([...this.#listenerErrors]);
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  publish<TInput extends ProjectEventInput>(
    input: TInput,
  ): ProjectEventOf<TInput['type']> {
    if (!isProjectEventType(input.type)) {
      throw new ProjectEventHubError(
        'PROJECT_EVENT_TYPE_INVALID',
        'Project event type is not recognized.',
      );
    }

    if (requiresEpoch(input.type) && (typeof input.epochId !== 'string' || input.epochId.length === 0)) {
      throw new ProjectEventHubError(
        'PROJECT_EVENT_EPOCH_REQUIRED',
        `${input.type} events require an epochId.`,
      );
    }

    let payload: ProjectEventOf<TInput['type']>['payload'];
    try {
      payload = freezeJsonValue(input.payload) as unknown as ProjectEventOf<TInput['type']>['payload'];
    } catch (error) {
      throw new ProjectEventHubError(
        'PROJECT_EVENT_PAYLOAD_INVALID',
        error instanceof Error ? error.message : 'Project event payload must be JSON.',
      );
    }

    const publishedEvent = freezeProjectEvent({
      ...(input.epochId === undefined ? {} : { epochId: input.epochId }),
      occurredAt: input.occurredAt ?? this.#now().toISOString(),
      payload,
      sequence: this.#sequence + 1,
      type: input.type,
    } as ProjectEvent);
    const event = publishedEvent as ProjectEventOf<TInput['type']>;
    this.#sequence = publishedEvent.sequence;

    this.#history.push(publishedEvent);
    if (this.#history.length > this.#replayLimit) {
      this.#history.shift();
    }

    for (const subscription of this.#subscriptions) {
      if (subscription.replaying) {
        subscription.pending.push(publishedEvent);
      }
    }

    this.#undelivered.push(publishedEvent);
    this.#drainLiveEvents();
    return event;
  }

  subscribe(
    options: ProjectEventSubscriptionOptions,
    listener: ProjectEventListener,
  ): ProjectEventSubscription;
  subscribe(
    listener: ProjectEventListener,
    options?: ProjectEventSubscriptionOptions,
  ): ProjectEventSubscription;
  subscribe(
    first: ProjectEventSubscriptionOptions | ProjectEventListener,
    second?: ProjectEventListener | ProjectEventSubscriptionOptions,
  ): ProjectEventSubscription {
    const listener = typeof first === 'function' ? first : second;
    const options = typeof first === 'function' ? second : first;

    if (typeof listener !== 'function') {
      throw new TypeError('A project event listener is required.');
    }

    const requestedAfter = ensureSequence(
      (options as ProjectEventSubscriptionOptions | undefined)?.afterSequence ?? 0,
    );
    const boundary = this.#sequence;
    if (requestedAfter > boundary) {
      throw new ProjectEventHubError(
        'PROJECT_EVENT_CURSOR_AHEAD',
        'afterSequence cannot be ahead of the current project event stream.',
      );
    }

    const subscription: Subscription = {
      closed: false,
      lastDeliveredSequence: requestedAfter,
      listener,
      pending: [],
      replaying: true,
    };
    this.#subscriptions.add(subscription);

    const firstRetained = this.#history[0]?.sequence;
    if (firstRetained !== undefined && requestedAfter < firstRetained - 1) {
      this.#deliverReplayGap(subscription, {
        earliestAvailableSequence: firstRetained,
        latestDroppedSequence: firstRetained - 1,
        requestedAfterSequence: requestedAfter,
        type: 'replay.gap',
      });
    }

    for (const event of this.#history) {
      if (event.sequence > requestedAfter && event.sequence <= boundary) {
        this.#deliver(subscription, event);
      }
    }

    while (!subscription.closed && subscription.pending.length > 0) {
      const event = subscription.pending.shift();
      if (event !== undefined) {
        this.#deliver(subscription, event);
      }
    }

    subscription.replaying = false;

    return {
      unsubscribe: () => this.#removeSubscription(subscription),
    };
  }

  #removeSubscription(subscription: Subscription): void {
    subscription.closed = true;
    this.#subscriptions.delete(subscription);
  }

  #reportListenerFailure(error: unknown, event: ProjectEventMessage): void {
    const failure = Object.freeze({ error, event });
    this.#listenerErrors.push(failure);
    if (this.#listenerErrors.length > maxRetainedListenerErrors) this.#listenerErrors.shift();
    try {
      this.#onListenerError?.(failure);
    } catch {
      // The reporting sink is observability-only and must not affect delivery.
    }
  }

  #notify(subscription: Subscription, event: ProjectEventMessage): void {
    try {
      subscription.listener(event);
    } catch (error) {
      this.#removeSubscription(subscription);
      this.#reportListenerFailure(error, event);
    }
  }

  #deliverReplayGap(subscription: Subscription, gap: ProjectReplayGap): void {
    if (!subscription.closed) {
      this.#notify(subscription, Object.freeze(gap));
    }
  }

  #deliver(subscription: Subscription, event: ProjectEvent): void {
    if (subscription.closed || event.sequence <= subscription.lastDeliveredSequence) {
      return;
    }

    subscription.lastDeliveredSequence = event.sequence;
    this.#notify(subscription, event);
  }

  #drainLiveEvents(): void {
    if (this.#dispatching) {
      return;
    }

    this.#dispatching = true;
    try {
      while (this.#undelivered.length > 0) {
        const event = this.#undelivered.shift();
        if (event === undefined) {
          continue;
        }

        for (const subscription of this.#subscriptions) {
          if (!subscription.replaying) {
            this.#deliver(subscription, event);
          }
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }
}
