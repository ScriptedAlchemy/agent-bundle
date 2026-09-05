import { randomUUID } from 'node:crypto';

import type { CanonicalAgentEvent } from '../routes/events.ts';
import type { EventPreflightResult } from './preflight.ts';

/**
 * The execution-kernel trace surface for conventional event routes (#600).
 *
 * One {@link EventTracer} lives for one hook execution — a hook wrapper
 * process or one shared-runtime request — and describes what the kernel did
 * with it as a sequence of frozen {@link EventTraceEvent}s: the preflight gate
 * (start, outcome), the deferred route load that only an `execute` gate
 * result triggers, provider materialization, the route render, and a terminal
 * failure. The surface is deliberately small and observer-agnostic: the
 * framework owns emission, a consumer owns the observer, and an absent
 * observer costs the kernel nothing beyond a boolean check.
 *
 * Invariants the tests hold:
 * - Every event carries the same frozen execution identity, a monotonic
 *   `sequence` (0, 1, 2, …) and a monotonic `at` timestamp in milliseconds.
 * - Events are frozen before they reach the observer; the observer cannot
 *   alter them and its exceptions never reach the kernel.
 * - `failure` is terminal: the tracer goes quiet afterwards.
 * - Nothing here carries payloads, reasons, stacks, or the error object
 *   itself — only the {@link EventTraceErrorSummary} projection.
 */

/** The kernel phases a trace can attribute time or a failure to. */
export const eventTracePhases = Object.freeze(['preflight', 'execute', 'providers', 'render'] as const);
export type EventTracePhase = (typeof eventTracePhases)[number];

/** Every discriminant of {@link EventTraceEvent}, for consumers that switch or filter. */
export const eventTraceEventKinds = Object.freeze([
  'preflight.start',
  'preflight.outcome',
  'execute.start',
  'providers.start',
  'providers.finish',
  'render.start',
  'render.finish',
  'failure',
] as const);
export type EventTraceEventKind = (typeof eventTraceEventKinds)[number];

/** Which runtime the deferred execute step loads the route in. */
export type EventTraceRuntime = 'shared' | 'standalone';

/** The gate decision without its reason text: `deny` is enough for a trace. */
export type EventTracePreflightOutcome = 'execute' | 'continue' | 'deny';

/**
 * Identity shared by every event of one execution. `executionId` is unique
 * per hook execution; `host` is the compiled target name, `nativeEvent` the
 * host's own event name for the canonical `event`.
 */
export interface EventTraceExecution {
  readonly event: CanonicalAgentEvent;
  readonly executionId: string;
  readonly host: string;
  readonly nativeEvent: string;
}

/** What an observer learns about a thrown value: name, message, string code. Never the value itself. */
export interface EventTraceErrorSummary {
  readonly code?: string;
  readonly message: string;
  readonly name: string;
}

interface EventTraceEventBase<K extends EventTraceEventKind, P extends EventTracePhase> {
  /** Monotonic milliseconds from the tracer's clock (`performance.now()` by default). */
  readonly at: number;
  readonly execution: EventTraceExecution;
  readonly kind: K;
  readonly phase: P;
  /** Position within this execution's trace, starting at 0. */
  readonly sequence: number;
}

export type EventTracePreflightStart = EventTraceEventBase<'preflight.start', 'preflight'>;
export interface EventTracePreflightOutcomeEvent extends EventTraceEventBase<'preflight.outcome', 'preflight'> {
  /** Present when `preflight.start` was observed on this tracer. */
  readonly durationMs?: number;
  readonly outcome: EventTracePreflightOutcome;
}
/** The gate returned `execute`: the kernel now loads the rendered route runtime. */
export interface EventTraceExecuteStart extends EventTraceEventBase<'execute.start', 'execute'> {
  readonly runtime: EventTraceRuntime;
}
export type EventTraceProvidersStart = EventTraceEventBase<'providers.start', 'providers'>;
export interface EventTraceProvidersFinish extends EventTraceEventBase<'providers.finish', 'providers'> {
  /** Providers materialized for this request. */
  readonly count: number;
  /** Present when `providers.start` was observed on this tracer. */
  readonly durationMs?: number;
}
export type EventTraceRenderStart = EventTraceEventBase<'render.start', 'render'>;
export interface EventTraceRenderFinish extends EventTraceEventBase<'render.finish', 'render'> {
  /** Present when `render.start` was observed on this tracer. */
  readonly durationMs?: number;
}
/** Terminal: the execution failed in `phase`. Nothing follows this event. */
export interface EventTraceFailure extends EventTraceEventBase<'failure', EventTracePhase> {
  /** Elapsed since the first event of this trace; absent when the failure is the first event. */
  readonly durationMs?: number;
  readonly error: EventTraceErrorSummary;
}

export type EventTraceEvent =
  | EventTracePreflightStart
  | EventTracePreflightOutcomeEvent
  | EventTraceExecuteStart
  | EventTraceProvidersStart
  | EventTraceProvidersFinish
  | EventTraceRenderStart
  | EventTraceRenderFinish
  | EventTraceFailure;

/** A consumer's sink. Called synchronously with a frozen event; exceptions are swallowed. */
export type EventTraceObserver = (event: EventTraceEvent) => void;

const eventTraceObserverSlot = Symbol.for('agent-bundle.event-trace-observer');
const observerRegistry = globalThis as typeof globalThis & Record<symbol, EventTraceObserver | undefined>;

/** Returns the process-local observer currently installed for kernel traces. */
export const eventTraceObserver = (): EventTraceObserver | undefined =>
  observerRegistry[eventTraceObserverSlot];

/**
 * Installs the process-local observer used by framework-created tracers.
 * The disposer restores the previous observer without disturbing a newer one.
 */
export const installEventTraceObserver = (observer: EventTraceObserver): (() => void) => {
  const previous = observerRegistry[eventTraceObserverSlot];
  observerRegistry[eventTraceObserverSlot] = observer;
  return () => {
    if (observerRegistry[eventTraceObserverSlot] === observer) {
      observerRegistry[eventTraceObserverSlot] = previous;
    }
  };
};

/**
 * The framework-owned emitter the kernel calls at each phase boundary. Every
 * method is safe to call at any time and never throws.
 */
export interface EventTracer {
  /** True once `failure` was recorded; later calls are dropped. */
  readonly closed: boolean;
  /** False when the tracer was created without an observer: every method is a no-op. */
  readonly enabled: boolean;
  readonly execution: EventTraceExecution;
  preflightStart(): void;
  preflightOutcome(result: EventPreflightResult): void;
  executeStart(runtime: EventTraceRuntime): void;
  providersStart(): void;
  providersFinish(count: number): void;
  renderStart(): void;
  renderFinish(): void;
  failure(phase: EventTracePhase, error: unknown): void;
}

export interface CreateEventTracerOptions {
  readonly execution: EventTraceExecution;
  /** Monotonic clock in milliseconds; `performance.now` when absent. */
  readonly now?: () => number;
  /** Absent means tracing is off for this execution. */
  readonly observer?: EventTraceObserver;
}

/** Longest message an {@link EventTraceErrorSummary} carries; longer ones end in an ellipsis. */
const MAX_ERROR_SUMMARY_MESSAGE_LENGTH = 512;
const UNPRINTABLE = '[unprintable]';
const NON_ERROR_NAME = 'NonError';

const requireNonBlank = (value: string, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Event trace execution ${field} must be a nonempty string.`);
  }
  return value;
};

/** Builds the frozen per-execution identity, minting a UUID `executionId` when none is given. */
export const eventTraceExecution = (
  input: Readonly<{
    readonly event: CanonicalAgentEvent;
    readonly executionId?: string;
    readonly host: string;
    readonly nativeEvent: string;
  }>,
): EventTraceExecution =>
  Object.freeze({
    event: input.event,
    executionId: input.executionId === undefined ? randomUUID() : requireNonBlank(input.executionId, 'executionId'),
    host: requireNonBlank(input.host, 'host'),
    nativeEvent: requireNonBlank(input.nativeEvent, 'nativeEvent'),
  });

const boundedMessage = (message: string): string =>
  message.length > MAX_ERROR_SUMMARY_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_SUMMARY_MESSAGE_LENGTH - 1)}…`
    : message;

/** Reads a property that may be a hostile getter; anything but a string yields `undefined`. */
const stringProperty = (value: object, key: string): string | undefined => {
  try {
    const read: unknown = (value as Record<string, unknown>)[key];
    return typeof read === 'string' ? read : undefined;
  } catch {
    return undefined;
  }
};

const printable = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return UNPRINTABLE;
  }
};

/**
 * Projects any thrown value into a frozen, JSON-safe {@link EventTraceErrorSummary}.
 * Never throws, never returns the error object, its stack, or its cause.
 */
export const summarizeEventTraceError = (error: unknown): EventTraceErrorSummary => {
  if (error instanceof Error) {
    const name = stringProperty(error, 'name');
    const message = stringProperty(error, 'message');
    const code = stringProperty(error, 'code');
    return Object.freeze({
      ...(code === undefined ? {} : { code }),
      message: boundedMessage(message ?? UNPRINTABLE),
      name: name === undefined || name === '' ? 'Error' : name,
    });
  }
  return Object.freeze({ message: boundedMessage(printable(error)), name: NON_ERROR_NAME });
};

const preflightOutcomeOf = (result: EventPreflightResult): EventTracePreflightOutcome => {
  if (result === 'execute') return 'execute';
  switch (result.outcome) {
    case 'continue':
      return 'continue';
    case 'deny':
      return 'deny';
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};

const durationField = (since: number | undefined, at: number): { readonly durationMs?: number } =>
  since === undefined ? {} : { durationMs: at - since };

/** A tracer that records nothing and reads no clock; only `closed` flips on `failure`. */
const disabledTracer = (execution: EventTraceExecution): EventTracer => {
  let closed = false;
  const noop = (): void => undefined;
  return {
    get closed() { return closed; },
    enabled: false,
    execution,
    executeStart: noop,
    failure: () => { closed = true; },
    preflightOutcome: noop,
    preflightStart: noop,
    providersFinish: noop,
    providersStart: noop,
    renderFinish: noop,
    renderStart: noop,
  };
};

/**
 * Creates the emitter for one execution. Without `observer` every method is
 * a no-op. With one, each method builds a frozen event, assigns the next
 * `sequence`, stamps `at` from `now`, and hands it to the observer inside a
 * try/catch: a throwing observer, a throwing clock, or re-entry from inside
 * the observer never changes what the caller sees.
 */
export const createEventTracer = (options: CreateEventTracerOptions): EventTracer => {
  const execution = options.execution;
  const observer = options.observer ?? eventTraceObserver();
  if (observer === undefined) return disabledTracer(execution);
  const now = options.now ?? (() => performance.now());
  let sequence = 0;
  let closed = false;
  let firstAt: number | undefined;
  const startedAt: Partial<Record<EventTracePhase, number>> = {};

  const readClock = (): number | undefined => {
    try {
      return now();
    } catch {
      return undefined;
    }
  };

  const deliver = (event: EventTraceEvent): void => {
    try {
      observer(event);
    } catch {
      // An observer is a consumer's concern; the kernel's behavior is not.
    }
  };

  /**
   * `build` receives the timestamp, the next sequence number, and the trace's
   * first timestamp before this event (undefined when this is the first).
   * The sequence advances only when an event is actually built, so a broken
   * clock leaves no gap.
   */
  const emit = (build: (at: number, sequence: number, traceStartedAt: number | undefined) => EventTraceEvent): void => {
    if (closed) return;
    const at = readClock();
    if (at === undefined) return;
    const traceStartedAt = firstAt;
    firstAt ??= at;
    const event = build(at, sequence, traceStartedAt);
    sequence += 1;
    deliver(Object.freeze(event));
  };

  return {
    get closed() { return closed; },
    enabled: true,
    execution,
    executeStart: (runtime) => {
      emit((at, next) => {
        startedAt.execute = at;
        return { at, execution, kind: 'execute.start', phase: 'execute', runtime, sequence: next };
      });
    },
    failure: (phase, error) => {
      const summary = summarizeEventTraceError(error);
      emit((at, next, traceStartedAt) => ({
        at,
        ...durationField(traceStartedAt, at),
        error: summary,
        execution,
        kind: 'failure',
        phase,
        sequence: next,
      }));
      closed = true;
    },
    preflightOutcome: (result) => {
      const outcome = preflightOutcomeOf(result);
      emit((at, next) => ({
        at,
        ...durationField(startedAt.preflight, at),
        execution,
        kind: 'preflight.outcome',
        outcome,
        phase: 'preflight',
        sequence: next,
      }));
    },
    preflightStart: () => {
      emit((at, next) => {
        startedAt.preflight = at;
        return { at, execution, kind: 'preflight.start', phase: 'preflight', sequence: next };
      });
    },
    providersFinish: (count) => {
      emit((at, next) => ({
        at,
        count,
        ...durationField(startedAt.providers, at),
        execution,
        kind: 'providers.finish',
        phase: 'providers',
        sequence: next,
      }));
    },
    providersStart: () => {
      emit((at, next) => {
        startedAt.providers = at;
        return { at, execution, kind: 'providers.start', phase: 'providers', sequence: next };
      });
    },
    renderFinish: () => {
      emit((at, next) => ({
        at,
        ...durationField(startedAt.render, at),
        execution,
        kind: 'render.finish',
        phase: 'render',
        sequence: next,
      }));
    },
    renderStart: () => {
      emit((at, next) => {
        startedAt.render = at;
        return { at, execution, kind: 'render.start', phase: 'render', sequence: next };
      });
    },
  };
};
