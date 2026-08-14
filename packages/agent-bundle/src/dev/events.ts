import {
  freezeProjectEvent,
  type ProjectEvent,
  type ProjectEventMessage,
  type ProjectEventType,
  type ProjectReplayGap,
} from './types.ts';

export interface ProjectEventInput<TPayload = unknown> {
  readonly epochId?: string;
  readonly occurredAt?: string;
  readonly payload: TPayload;
  readonly type: ProjectEventType;
}

export interface ProjectEventSubscriptionOptions {
  /** Resume after this event. Omit to replay the retained history. */
  readonly afterSequence?: number;
}

export type ProjectEventListener = (event: ProjectEventMessage) => void;

export interface ProjectEventSubscription {
  unsubscribe(): void;
}

export interface ProjectEventHubOptions {
  /** Number of published events retained for reconnecting clients. */
  readonly replayLimit?: number;
  readonly now?: () => Date;
}

interface Subscription {
  closed: boolean;
  lastDeliveredSequence: number;
  listener: ProjectEventListener;
  pending: ProjectEvent[];
  replaying: boolean;
}

const defaultReplayLimit = 256;

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

/**
 * Process-local ordered stream for project state and runtime activity. It has no
 * persistence or transport concerns; callers attach their own browser bridge.
 */
export class ProjectEventHub {
  readonly #history: ProjectEvent[] = [];
  readonly #now: () => Date;
  readonly #replayLimit: number;
  readonly #subscriptions = new Set<Subscription>();
  readonly #undelivered: ProjectEvent[] = [];
  #dispatching = false;
  #sequence = 0;

  constructor(options: ProjectEventHubOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#replayLimit = ensureReplayLimit(options.replayLimit ?? defaultReplayLimit);
  }

  get latestSequence(): number {
    return this.#sequence;
  }

  publish<TPayload>(input: ProjectEventInput<TPayload>): ProjectEvent<TPayload> {
    const event = freezeProjectEvent({
      ...(input.epochId === undefined ? {} : { epochId: input.epochId }),
      occurredAt: input.occurredAt ?? this.#now().toISOString(),
      payload: input.payload,
      sequence: ++this.#sequence,
      type: input.type,
    });

    this.#history.push(event);
    if (this.#history.length > this.#replayLimit) {
      this.#history.shift();
    }

    for (const subscription of this.#subscriptions) {
      if (subscription.replaying) {
        subscription.pending.push(event);
      }
    }

    this.#undelivered.push(event);
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
    const afterSequence = Math.min(requestedAfter, boundary);
    const subscription: Subscription = {
      closed: false,
      lastDeliveredSequence: afterSequence,
      listener,
      pending: [],
      replaying: true,
    };
    this.#subscriptions.add(subscription);

    const firstRetained = this.#history[0]?.sequence;
    if (firstRetained !== undefined && afterSequence < firstRetained - 1) {
      this.#deliverReplayGap(subscription, {
        earliestAvailableSequence: firstRetained,
        latestDroppedSequence: firstRetained - 1,
        requestedAfterSequence: requestedAfter,
        type: 'replay.gap',
      });
    }

    for (const event of this.#history) {
      if (event.sequence > afterSequence && event.sequence <= boundary) {
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
      unsubscribe: () => {
        subscription.closed = true;
        this.#subscriptions.delete(subscription);
      },
    };
  }

  #deliverReplayGap(subscription: Subscription, gap: ProjectReplayGap): void {
    if (!subscription.closed) {
      subscription.listener(Object.freeze(gap));
    }
  }

  #deliver(subscription: Subscription, event: ProjectEvent): void {
    if (subscription.closed || event.sequence <= subscription.lastDeliveredSequence) {
      return;
    }

    subscription.lastDeliveredSequence = event.sequence;
    subscription.listener(event);
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

export const createProjectEventHub = (
  options?: ProjectEventHubOptions,
): ProjectEventHub => new ProjectEventHub(options);
