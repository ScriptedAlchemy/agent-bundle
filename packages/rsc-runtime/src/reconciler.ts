import { Clock, Deferred, Duration, Effect, Exit, Option, Queue, Stream, type Scope } from 'effect';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createFromReadableStream } from 'react-server-dom-rspack/client.node';

import {
  AgentContractError,
  createAgentRenderEventSequence,
  agentRenderAbortError,
  elapsedTimeExceeded,
  resolveAgentRenderLimits,
  type AgentRenderError,
  type AgentRenderEvent,
  type AgentRenderEventInput,
  type AgentRenderEventSequence,
  type AgentRenderLimits,
} from './agent-document.js';
import type { AgentProgressReporter, AgentProgressUpdate } from './agent-request.js';
import { decodeAgentDocument } from './decode-document.js';
import {
  abortToInterrupt,
  isAbortError,
  mapCause,
  runPromise,
  scopedAbortSignal,
  streamToReadableStream,
  toRuntimeError,
} from './effect/boundary.js';
import {
  createFlightDemand,
  emitBoundRenderEvent,
  type FlightDemand,
} from './effect/render-stream.js';
import { ensureAgentFlightManifest } from './flight-manifest.js';

const REACT_FRAGMENT = Symbol.for('react.fragment');
const REACT_LAZY = Symbol.for('react.lazy');
const REACT_SUSPENSE = Symbol.for('react.suspense');

export interface AgentFlightDecodeOptions {
  readonly limits?: Partial<AgentRenderLimits>;
  readonly signal?: AbortSignal;
}

interface FlightThenable<T = unknown> extends PromiseLike<T> {
  readonly reason?: unknown;
  readonly status?: string;
  readonly value?: T;
}

interface LazyElement {
  readonly $$typeof: symbol;
  readonly _init?: (payload: FlightThenable) => unknown;
  readonly _payload: FlightThenable;
}

interface PendingBoundary {
  readonly id: string;
  readonly thenable: PromiseLike<unknown>;
}

type ClassifiedNode =
  | { readonly kind: 'empty' }
  | { readonly kind: 'leaf'; readonly value: string | number }
  | { readonly kind: 'array'; readonly value: readonly ReactNode[] }
  | { readonly kind: 'thenable'; readonly value: FlightThenable }
  | { readonly kind: 'lazy'; readonly value: LazyElement }
  | { readonly kind: 'suspense'; readonly value: ReactElement }
  | { readonly kind: 'fragment'; readonly value: ReactElement }
  | { readonly kind: 'protocol'; readonly value: ReactElement };

const abortError = agentRenderAbortError;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isThenable = (value: unknown): value is FlightThenable =>
  isObject(value) && typeof value.then === 'function';

const isLazyElement = (value: unknown): value is LazyElement =>
  isObject(value) && value.$$typeof === REACT_LAZY && isThenable(value._payload);

const childList = (children: unknown): readonly ReactNode[] => {
  if (children === undefined || children === null || children === false || children === true) return [];
  return Array.isArray(children) ? children as readonly ReactNode[] : [children as ReactNode];
};

const joinPath = (parent: string, index: number): string =>
  parent === '' ? String(index) : `${parent}.${index}`;

const classifyNode = (node: ReactNode): ClassifiedNode => {
  if (node === null || node === undefined || typeof node === 'boolean') return { kind: 'empty' };
  if (typeof node === 'string' || typeof node === 'number') return { kind: 'leaf', value: node };
  if (Array.isArray(node)) return { kind: 'array', value: node };
  if (isLazyElement(node)) return { kind: 'lazy', value: node };
  if (isThenable(node)) return { kind: 'thenable', value: node };
  if (!isValidElement(node)) {
    throw new AgentContractError('invalid-document', 'Flight output contained an unsupported node');
  }
  const type: unknown = node.type;
  if (type === REACT_SUSPENSE) return { kind: 'suspense', value: node };
  if (type === REACT_FRAGMENT) return { kind: 'fragment', value: node };
  if (typeof type === 'string') return { kind: 'protocol', value: node };
  throw new AgentContractError(
    'invalid-document',
    `Flight output must contain only Agent protocol elements; function components and HTML are unsupported`,
  );
};

const thenableStatus = (thenable: FlightThenable): 'pending' | 'fulfilled' | 'rejected' => {
  switch (thenable.status) {
    case 'fulfilled':
    case 'resolved_model':
      return 'fulfilled';
    case 'rejected':
      return 'rejected';
    case 'pending':
    case 'halted':
    case undefined:
      return 'pending';
    default:
      return 'pending';
  }
};

const unwrapLazy = (lazy: LazyElement): unknown => {
  if (lazy._init !== undefined) return lazy._init(lazy._payload);
  return lazy._payload.value;
};

const renderErrorFrom = (reason: unknown): AgentRenderError => {
  if (reason instanceof Error) {
    return Object.freeze({ code: 'boundary', message: reason.message });
  }
  if (isObject(reason) && typeof reason.message === 'string' && reason.message.trim() !== '') {
    return Object.freeze({
      code: typeof reason.digest === 'string' && reason.digest.trim() !== '' ? reason.digest : 'boundary',
      message: reason.message,
    });
  }
  return Object.freeze({ code: 'boundary', message: 'Suspended boundary failed' });
};

interface MaterializeContext {
  readonly ids: Map<string, string>;
  readonly pending: PendingBoundary[];
  readonly rejected: Array<{ readonly error: AgentRenderError; readonly id: string }>;
}

const boundaryId = (path: string, ids: Map<string, string>): string => {
  const existing = ids.get(path);
  if (existing !== undefined) return existing;
  const id = `b:${path}`;
  ids.set(path, id);
  return id;
};

const errorElement = (error: AgentRenderError): ReactElement =>
  createElement('agent-error', { code: error.code }, error.message);

const materializePending = (
  thenable: FlightThenable,
  path: string,
  fallback: ReactNode,
  ctx: MaterializeContext,
): ReactNode => {
  const status = thenableStatus(thenable);
  switch (status) {
    case 'pending': {
      const id = boundaryId(path, ctx.ids);
      ctx.pending.push({ id, thenable });
      return materializeNode(fallback, `${path}~fallback`, ctx);
    }
    case 'rejected': {
      const id = boundaryId(path, ctx.ids);
      const error = renderErrorFrom(thenable.reason);
      ctx.rejected.push({ error, id });
      return errorElement(error);
    }
    case 'fulfilled':
      return materializeNode(thenable.value as ReactNode, path, ctx);
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

const materializeNode = (node: ReactNode, path: string, ctx: MaterializeContext): ReactNode => {
  const classified = classifyNode(node);
  switch (classified.kind) {
    case 'empty':
      return null;
    case 'leaf':
      return classified.value;
    case 'array':
      return classified.value.map((child, index) => materializeNode(child, joinPath(path, index), ctx));
    case 'thenable':
      return materializePending(classified.value, path, null, ctx);
    case 'lazy': {
      const status = thenableStatus(classified.value._payload);
      switch (status) {
        case 'pending':
        case 'rejected':
          return materializePending(classified.value._payload, path, null, ctx);
        case 'fulfilled':
          return materializeNode(unwrapLazy(classified.value) as ReactNode, path, ctx);
        default: {
          const exhaustive: never = status;
          return exhaustive;
        }
      }
    }
    case 'suspense': {
      const props = classified.value.props as { readonly children?: ReactNode; readonly fallback?: ReactNode };
      const children = props.children;
      const fallback = props.fallback;
      const childKind = classifyNode(children);
      switch (childKind.kind) {
        case 'lazy': {
          const status = thenableStatus(childKind.value._payload);
          switch (status) {
            case 'pending':
            case 'rejected':
              return materializePending(childKind.value._payload, path, fallback, ctx);
            case 'fulfilled':
              return materializeNode(unwrapLazy(childKind.value) as ReactNode, path, ctx);
            default: {
              const exhaustive: never = status;
              return exhaustive;
            }
          }
        }
        case 'thenable':
          return materializePending(childKind.value, path, fallback, ctx);
        case 'empty':
        case 'leaf':
        case 'array':
        case 'suspense':
        case 'fragment':
        case 'protocol':
          return materializeNode(children, path, ctx);
        default: {
          const exhaustive: never = childKind;
          return exhaustive;
        }
      }
    }
    case 'fragment':
      return materializeNode((classified.value.props as { readonly children?: ReactNode }).children, path, ctx);
    case 'protocol': {
      const props = classified.value.props as { readonly children?: ReactNode } & Record<string, unknown>;
      const { children, ...rest } = props;
      const materialized: ReactNode[] = [];
      for (const [index, child] of childList(children).entries()) {
        const next = materializeNode(child, joinPath(path, index), ctx);
        if (Array.isArray(next)) materialized.push(...next);
        else materialized.push(next);
      }
      return createElement(classified.value.type, rest, ...materialized);
    }
    default: {
      const exhaustive: never = classified;
      return exhaustive;
    }
  }
};

interface TreeSnapshot {
  readonly pending: readonly PendingBoundary[];
  readonly rejected: MaterializeContext['rejected'];
  readonly tree: ReactNode;
}

const snapshotTree = (root: ReactNode, ids: Map<string, string>): TreeSnapshot => {
  const ctx: MaterializeContext = { ids, pending: [], rejected: [] };
  return { pending: ctx.pending, rejected: ctx.rejected, tree: materializeNode(root, '', ctx) };
};

const hostError = (signal: AbortSignal, error: unknown): Error =>
  signal.aborted || isAbortError(error) ? abortError() : toRuntimeError(error);

type SettledBoundary = {
  readonly boundary: PendingBoundary;
  readonly error?: unknown;
  readonly ok: boolean;
};

/**
 * Waits for the first pending boundary to settle either way. The rejection
 * reason is data, not a failure to normalize: React rejects a boundary with a
 * `{ message, digest }` object that `renderErrorFrom` reads, so mapping it
 * through `toRuntimeError` would erase the digest. Both settlements are folded
 * inside the promise, which therefore cannot reject and never puts an
 * `unknown` on the Effect error channel.
 */
const waitSettledBoundary = (
  pending: readonly PendingBoundary[],
): Effect.Effect<SettledBoundary> =>
  Effect.raceAll(
    pending.map((boundary) =>
      Effect.promise((): Promise<SettledBoundary> => Promise.resolve(boundary.thenable).then(
        () => ({ boundary, ok: true as const }),
        (error: unknown) => ({ boundary, error, ok: false as const }),
      )),
    ),
  );

const waitOrDeadline = <A>(
  wait: Effect.Effect<A, Error>,
  sequence: AgentRenderEventSequence,
): Effect.Effect<A, Error> => {
  const remaining = sequence.remainingMs;
  if (remaining <= 0) return Effect.fail(elapsedTimeExceeded(sequence.maxElapsedMs));
  return Effect.raceFirst(
    wait,
    Effect.sleep(Duration.millis(remaining)).pipe(
      Effect.flatMap(() => Effect.fail(elapsedTimeExceeded(sequence.maxElapsedMs))),
    ),
  );
};

const settledBoundaryInputs = (
  previous: TreeSnapshot,
  next: TreeSnapshot,
  winner: SettledBoundary,
  limits: Partial<AgentRenderLimits> | undefined,
): readonly AgentRenderEventInput[] => {
  const stillPending = new Set(next.pending.map((boundary) => boundary.id));
  const rejectedById = new Map(next.rejected.map((entry) => [entry.id, entry.error] as const));
  const document = decodeAgentDocument(next.tree, limits);
  const inputs: AgentRenderEventInput[] = [];
  const emitFor = (id: string, fallback?: SettledBoundary): void => {
    const rejected = rejectedById.get(id);
    if (rejected !== undefined) {
      inputs.push({ boundaryId: id, error: rejected, type: 'error' });
      return;
    }
    if (fallback !== undefined && !fallback.ok) {
      inputs.push({ boundaryId: id, error: renderErrorFrom(fallback.error), type: 'error' });
      return;
    }
    if (stillPending.has(id) && id !== winner.boundary.id) return;
    inputs.push({ boundaryId: id, document, type: 'replace' });
  };
  emitFor(winner.boundary.id, winner);
  for (const boundary of previous.pending) {
    if (boundary.id === winner.boundary.id) continue;
    emitFor(boundary.id);
  }
  return inputs;
};

type LoopWait =
  | { readonly kind: 'boundary'; readonly winner: SettledBoundary }
  | { readonly kind: 'progress'; readonly input: AgentRenderEventInput };

const reconcileLoopStream = (
  root: ReactNode,
  ids: Map<string, string>,
  initial: TreeSnapshot,
  limits: Partial<AgentRenderLimits> | undefined,
  flightDone: Deferred.Deferred<void, Error>,
  progressInputs: Queue.Queue<AgentRenderEventInput>,
  sequence: AgentRenderEventSequence,
): Stream.Stream<AgentRenderEventInput, Error> =>
  Stream.paginate(
    initial,
    (snapshot): Effect.Effect<
      readonly [readonly AgentRenderEventInput[], Option.Option<TreeSnapshot>],
      Error
    > => {
      if (snapshot.pending.length === 0) {
        return waitOrDeadline(Deferred.await(flightDone), sequence).pipe(
          Effect.andThen(Queue.clear(progressInputs)),
          Effect.flatMap((queued) =>
            Effect.try({
              catch: (error) => toRuntimeError(error),
              try: () =>
                [
                  [
                    ...queued,
                    { document: decodeAgentDocument(snapshot.tree, limits), type: 'complete' as const },
                  ],
                  Option.none(),
                ] as const,
            }),
          ),
        );
      }
      return Effect.raceFirst(
        waitOrDeadline(waitSettledBoundary(snapshot.pending), sequence).pipe(
          Effect.map((winner): LoopWait => ({ kind: 'boundary', winner })),
        ),
        Queue.take(progressInputs).pipe(
          Effect.map((input): LoopWait => ({ kind: 'progress', input })),
        ),
      ).pipe(
        Effect.flatMap((event) => {
          switch (event.kind) {
            case 'progress':
              return Effect.succeed([[event.input], Option.some(snapshot)] as const);
            case 'boundary':
              return Effect.try({
                catch: (error) => toRuntimeError(error),
                try: () => {
                  const next = snapshotTree(root, ids);
                  return [settledBoundaryInputs(snapshot, next, event.winner, limits), Option.some(next)] as const;
                },
              });
            default: {
              const exhaustive: never = event;
              return exhaustive;
            }
          }
        }),
      );
    },
  );

const gatedFlightStream = (
  flight: ReadableStream<Uint8Array>,
  demand: FlightDemand,
  flightDone: Deferred.Deferred<void, Error>,
): Stream.Stream<Uint8Array, Error> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => flight.getReader()),
        (handle, exit) => Effect.gen(function*() {
          const cancelExit = yield* Effect.exit(Effect.tryPromise({
            catch: (error) => toRuntimeError(error),
            try: () => handle.cancel(),
          }));
          if (Exit.isFailure(exit)) {
            yield* Deferred.fail(flightDone, mapCause(exit.cause));
            return;
          }
          if (Exit.isFailure(cancelExit)) {
            const error = mapCause(cancelExit.cause);
            yield* Deferred.fail(flightDone, error);
            return yield* Effect.die(error);
          }
          yield* Deferred.succeed(flightDone, undefined);
        }),
      );
      return Stream.unfold(undefined, () =>
        demand.wait.pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              catch: (error) => toRuntimeError(error),
              try: () => reader.read(),
            }),
          ),
          Effect.map((next) => (next.done ? undefined : [next.value, undefined] as const)),
        ),
      );
    }),
  );

const decodeFlightRoot = (
  flight: ReadableStream<Uint8Array>,
  demand: FlightDemand,
  signal: AbortSignal,
  flightDone: Deferred.Deferred<void, Error>,
): Effect.Effect<ReactNode, Error, Scope.Scope> =>
  Effect.gen(function*() {
    ensureAgentFlightManifest();
    // Teardown must interrupt the Flight source, never `readable.cancel()`:
    // the Flight client below holds this readable's reader, so cancel() on
    // the locked stream rejects (ERR_INVALID_STATE), and that rejection
    // would defect the closing scope and wedge the event stream's exit
    // (the maxEvents hang). The scoped signal interrupts the source stream
    // without touching the locked ReadableStream.
    const flightAbort = yield* scopedAbortSignal;
    const readable = streamToReadableStream(gatedFlightStream(flight, demand, flightDone), {
      signal: flightAbort,
      strategy: { highWaterMark: 1 },
    });
    return yield* Effect.tryPromise({
      catch: (error) => hostError(signal, error),
      try: () =>
        createFromReadableStream<ReactNode>(readable, { unstable_allowPartialStream: true }),
    });
  });

const progressInput = (update: AgentProgressUpdate): AgentRenderEventInput => ({
  completed: update.completed ?? 0,
  ...(update.message === undefined ? {} : { message: update.message }),
  ...(update.total === undefined ? {} : { total: update.total }),
  type: 'progress',
});

export interface AgentRenderEventStreamOptions {
  /**
   * Time source for the `maxElapsedMs` deadline: both the event sequence's
   * elapsed check and the pending-boundary deadline sleep read it. Defaults to
   * the runtime clock; tests inject a `TestClock` so no real time elapses.
   */
  readonly clock?: Clock.Clock;
  readonly demand: FlightDemand;
  readonly flight: Promise<ReadableStream<Uint8Array>>;
  readonly limits?: Partial<AgentRenderLimits>;
  readonly signal: AbortSignal;
}

export interface AgentRenderEventSession {
  readonly events: Stream.Stream<AgentRenderEvent, Error>;
  readonly progress: AgentProgressReporter;
}

const handoffRequired = (): AgentContractError =>
  new AgentContractError(
    'handoff-required',
    'The render is complete; later work requires a new invocation handoff',
  );

/**
 * Invocation-local render pipeline: Flight bytes as a pull-gated Stream,
 * pending boundaries as `Stream.paginate`, contract bounds as the emit
 * stage. `progress` is created synchronously so the host can execute in the
 * same turn as `stream()`. Pre-shell reports buffer (capped by maxEvents);
 * live reports wait on a demand-bounded queue (capacity 0).
 */
export const createAgentRenderEventSession = (
  options: AgentRenderEventStreamOptions,
): AgentRenderEventSession => {
  const clock = options.clock;
  const sequence = createAgentRenderEventSequence(
    options.limits,
    clock === undefined ? undefined : () => clock.currentTimeMillisUnsafe(),
  );
  const maxBufferedProgress = resolveAgentRenderLimits(options.limits).maxEvents;
  let offerProgress: ((input: AgentRenderEventInput) => Effect.Effect<void, Error>) | undefined;
  let progressFailure: Error | undefined;
  const bufferedProgress: AgentRenderEventInput[] = [];
  const progress: AgentProgressReporter = Object.freeze({
    report: async (update: AgentProgressUpdate) => {
      if (progressFailure !== undefined) throw progressFailure;
      if (sequence.completed) throw handoffRequired();
      const input = progressInput(update);
      if (offerProgress === undefined) {
        if (bufferedProgress.length >= maxBufferedProgress) {
          throw new AgentContractError(
            'event-count-exceeded',
            `Agent render event count exceeds ${String(maxBufferedProgress)}`,
          );
        }
        bufferedProgress.push(input);
        return;
      }
      await runPromise(offerProgress(input));
    },
  });
  const events = Stream.unwrap(
    Effect.gen(function*() {
      const progressInputs = yield* Queue.bounded<AgentRenderEventInput>(0);
      const flightDone = yield* Deferred.make<void, Error>();
      const bindProgress = (): void => {
        offerProgress = (input) =>
          Queue.offer(progressInputs, input).pipe(
            Effect.flatMap((accepted) => {
              if (progressFailure !== undefined) return Effect.fail(progressFailure);
              if (!accepted) return Effect.fail(handoffRequired());
              return Effect.void;
            }),
          );
      };
      const finalizeProgress = (error: Error): Effect.Effect<void> =>
        Effect.sync(() => {
          progressFailure = error;
        }).pipe(Effect.andThen(Queue.shutdown(progressInputs)));
      const setup = Effect.gen(function*() {
        const flight = yield* Effect.tryPromise({
          catch: (error) => hostError(options.signal, error),
          try: () => options.flight,
        });
        if (options.signal.aborted) return yield* Effect.fail(abortError());
        const root = yield* decodeFlightRoot(flight, options.demand, options.signal, flightDone);
        if (options.signal.aborted) return yield* Effect.fail(abortError());
        const prepared = yield* Effect.try({
          catch: (error) => toRuntimeError(error),
          try: () => {
            const ids = new Map<string, string>();
            const initial = snapshotTree(root, ids);
            return {
              ids,
              initial,
              shellInput: {
                document: decodeAgentDocument(initial.tree, options.limits),
                type: 'shell' as const,
              } satisfies AgentRenderEventInput,
            };
          },
        });
        bindProgress();
        return Stream.concat(
          Stream.fromArray([prepared.shellInput, ...bufferedProgress]),
          reconcileLoopStream(
            root,
            prepared.ids,
            prepared.initial,
            options.limits,
            flightDone,
            progressInputs,
            sequence,
          ),
        ).pipe(
          Stream.mapEffect((input) => emitBoundRenderEvent(sequence, input)),
          Stream.tap((event) => (event.type === 'shell' ? options.demand.markShell : Effect.void)),
          Stream.takeUntil((event) => event.type === 'complete'),
          Stream.onExit((exit) => {
            if (Exit.isSuccess(exit)) return finalizeProgress(handoffRequired());
            const error = mapCause(exit.cause);
            return finalizeProgress(sequence.completed && isAbortError(error) ? handoffRequired() : error);
          }),
        );
      });
      return yield* setup.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? finalizeProgress(mapCause(exit.cause)) : Effect.void),
      );
    }),
  );
  return {
    events: clock === undefined ? events : Stream.provideService(events, Clock.Clock, clock),
    progress,
  };
};


export const toPublicEventStream = (
  events: Stream.Stream<AgentRenderEvent, Error>,
  demand: FlightDemand,
  signal: AbortSignal,
): ReadableStream<AgentRenderEvent> =>
  streamToReadableStream(Stream.interruptWhen(events, abortToInterrupt(signal)), {
    closeOn: (event) => event.type === 'complete',
    onPull: demand.notePull,
    onPullDelivered: demand.notePullEnd,
    strategy: { highWaterMark: 0 },
  });

export const decodeAgentFlightStream = (
  flight: ReadableStream<Uint8Array>,
  options: AgentFlightDecodeOptions = {},
): ReadableStream<AgentRenderEvent> => {
  const signal = options.signal ?? new AbortController().signal;
  const demand = createFlightDemand();
  return toPublicEventStream(
    createAgentRenderEventSession({
      demand,
      flight: Promise.resolve(flight),
      limits: options.limits,
      signal,
    }).events,
    demand,
    signal,
  );
};
