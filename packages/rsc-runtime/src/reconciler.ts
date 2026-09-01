import { Effect, Option, Queue, Stream, type Scope } from 'effect';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createFromReadableStream } from 'react-server-dom-rspack/client.node';

import {
  AgentContractError,
  createAgentRenderEventSequence,
  type AgentRenderError,
  type AgentRenderEvent,
  type AgentRenderEventInput,
  type AgentRenderLimits,
} from './agent-document.js';
import type { AgentProgressReporter, AgentProgressUpdate } from './agent-request.js';
import { decodeAgentDocument } from './decode-document.js';
import {
  abortToInterrupt,
  isAbortError,
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

const abortError = (): DOMException => new DOMException('Agent render was aborted', 'AbortError');

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
              return materializePending(childKind.value._payload, path, fallback, ctx);
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

const waitSettledBoundary = (
  pending: readonly PendingBoundary[],
): Effect.Effect<{ readonly boundary: PendingBoundary; readonly error?: unknown; readonly ok: boolean }, Error> =>
  Effect.raceAll(
    pending.map((boundary) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: () => Promise.resolve(boundary.thenable),
      }).pipe(
        Effect.map(() => ({ boundary, ok: true as const })),
        Effect.catch((error) => Effect.succeed({ boundary, error, ok: false as const })),
      ),
    ),
  );

type ReconcileState =
  | { readonly kind: 'shell'; readonly snapshot: TreeSnapshot }
  | { readonly kind: 'loop'; readonly snapshot: TreeSnapshot };

const reconcileInputStream = (root: ReactNode): Stream.Stream<AgentRenderEventInput, Error> => {
  const ids = new Map<string, string>();
  const initial = snapshotTree(root, ids);
  return Stream.paginate(
    { kind: 'shell', snapshot: initial } satisfies ReconcileState,
    (state): Effect.Effect<
      readonly [readonly AgentRenderEventInput[], Option.Option<ReconcileState>],
      Error
    > => {
      switch (state.kind) {
        case 'shell':
          return Effect.try({
            catch: (error) => toRuntimeError(error),
            try: () =>
              [
                [{ document: decodeAgentDocument(state.snapshot.tree), type: 'shell' as const }],
                Option.some({ kind: 'loop' as const, snapshot: state.snapshot }),
              ] as const,
          });
        case 'loop': {
          if (state.snapshot.pending.length === 0) {
            return Effect.try({
              catch: (error) => toRuntimeError(error),
              try: () =>
                [
                  [{ document: decodeAgentDocument(state.snapshot.tree), type: 'complete' as const }],
                  Option.none(),
                ] as const,
            });
          }
          return waitSettledBoundary(state.snapshot.pending).pipe(
            Effect.flatMap((settled) =>
              Effect.try({
                catch: (error) => toRuntimeError(error),
                try: () => {
                  const snapshot = snapshotTree(root, ids);
                  const input: AgentRenderEventInput = settled.ok
                    ? {
                      boundaryId: settled.boundary.id,
                      document: decodeAgentDocument(snapshot.tree),
                      type: 'replace',
                    }
                    : {
                      boundaryId: settled.boundary.id,
                      error: renderErrorFrom(settled.error),
                      type: 'error',
                    };
                  return [[input], Option.some({ kind: 'loop' as const, snapshot })] as const;
                },
              }),
            ),
          );
        }
        default: {
          const exhaustive: never = state;
          return exhaustive;
        }
      }
    },
  );
};

const gatedFlightStream = (
  flight: ReadableStream<Uint8Array>,
  demand: FlightDemand,
): Stream.Stream<Uint8Array, Error> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => flight.getReader()),
        (handle) => Effect.promise(() => handle.cancel().then(() => undefined)),
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
    const readable = streamToReadableStream(gatedFlightStream(flight, demand), {
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
  readonly demand: FlightDemand;
  readonly flight: Promise<ReadableStream<Uint8Array>>;
  readonly limits?: Partial<AgentRenderLimits>;
  readonly signal: AbortSignal;
}

export interface AgentRenderEventSession {
  readonly events: Stream.Stream<AgentRenderEvent, Error>;
  readonly progress: AgentProgressReporter;
}

/**
 * Invocation-local render pipeline: Flight bytes as a pull-gated Stream,
 * pending boundaries as `Stream.paginate`, contract bounds as the emit
 * stage. `progress` is created synchronously so the host can execute in the
 * same turn as `stream()`.
 */
export const createAgentRenderEventSession = (
  options: AgentRenderEventStreamOptions,
): AgentRenderEventSession => {
  const sequence = createAgentRenderEventSequence(options.limits);
  let offerProgress: ((input: AgentRenderEventInput) => Effect.Effect<void, Error>) | undefined;
  const bufferedProgress: AgentRenderEventInput[] = [];
  const progress: AgentProgressReporter = Object.freeze({
    report: async (update: AgentProgressUpdate) => {
      if (sequence.completed) {
        throw new AgentContractError(
          'handoff-required',
          'The render is complete; later work requires a new invocation handoff',
        );
      }
      const input = progressInput(update);
      if (offerProgress === undefined) {
        bufferedProgress.push(input);
        return;
      }
      await runPromise(offerProgress(input));
    },
  });
  const events = Stream.unwrap(
    Effect.gen(function*() {
      const progressInputs = yield* Queue.unbounded<AgentRenderEventInput>();
      offerProgress = (input) => Queue.offer(progressInputs, input).pipe(Effect.asVoid);
      for (const input of bufferedProgress) {
        yield* Queue.offer(progressInputs, input);
      }
      const flight = yield* Effect.tryPromise({
        catch: (error) => hostError(options.signal, error),
        try: () => options.flight,
      });
      if (options.signal.aborted) return yield* Effect.fail(abortError());
      const root = yield* decodeFlightRoot(flight, options.demand, options.signal);
      if (options.signal.aborted) return yield* Effect.fail(abortError());
      return Stream.merge(
        reconcileInputStream(root),
        Stream.fromQueue(progressInputs),
        { haltStrategy: 'left' },
      ).pipe(
        Stream.mapEffect((input) => emitBoundRenderEvent(sequence, input)),
        Stream.tap((event) => (event.type === 'shell' ? options.demand.markShell : Effect.void)),
        Stream.takeUntil((event) => event.type === 'complete'),
        Stream.ensuring(Queue.shutdown(progressInputs)),
      );
    }),
  );
  return { events, progress };
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
