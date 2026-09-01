import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createFromReadableStream } from 'react-server-dom-rspack/client.node';

import {
  AgentContractError,
  createAgentRenderEventSequence,
  type AgentRenderError,
  type AgentRenderEvent,
  type AgentRenderEventSequence,
  type AgentRenderLimits,
} from './agent-document.js';
import { decodeAgentDocument } from './decode-document.js';
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

const snapshotTree = (root: ReactNode, ids: Map<string, string>) => {
  const ctx: MaterializeContext = { ids, pending: [], rejected: [] };
  return { pending: ctx.pending, rejected: ctx.rejected, tree: materializeNode(root, '', ctx) };
};

interface DemandGate {
  readonly consume: () => void;
  readonly notify: () => void;
  readonly wait: () => Promise<void>;
}

const createDemandGate = (): DemandGate => {
  let notifyWaiter: (() => void) | undefined;
  let signaled = false;
  return {
    consume() {
      signaled = false;
    },
    notify() {
      signaled = true;
      const waiter = notifyWaiter;
      notifyWaiter = undefined;
      waiter?.();
    },
    wait() {
      if (signaled) {
        signaled = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        notifyWaiter = () => {
          signaled = false;
          resolve();
        };
      });
    },
  };
};

export interface LiveEventStream {
  readonly emit: (event: AgentRenderEvent) => Promise<void>;
  readonly fail: (error: unknown) => void;
  readonly holdFlight: () => boolean;
  readonly readable: ReadableStream<AgentRenderEvent>;
  readonly waitForFlightDemand: () => Promise<void>;
}

const createLiveEventStream = (signal: AbortSignal): LiveEventStream => {
  const buffer: AgentRenderEvent[] = [];
  const space = createDemandGate();
  const data = createDemandGate();
  const flight = createDemandGate();
  let waitingPulls = 0;
  let shellEmitted = false;
  let failed: unknown;
  let closed = false;

  const readable = new ReadableStream<AgentRenderEvent>({
    cancel() {
      closed = true;
      space.notify();
      data.notify();
      flight.notify();
    },
    pull(controller) {
      if (failed !== undefined) {
        controller.error(failed);
        return;
      }
      const deliver = (): void => {
        if (failed !== undefined) {
          controller.error(failed);
          return;
        }
        const event = buffer.shift();
        if (event === undefined) {
          controller.close();
          return;
        }
        if (event.type === 'shell') shellEmitted = true;
        controller.enqueue(event);
        space.notify();
        if (event.type === 'complete') controller.close();
      };
      if (buffer.length > 0) {
        data.consume();
        deliver();
        return;
      }
      waitingPulls += 1;
      flight.notify();
      return data.wait().then(() => {
        waitingPulls = Math.max(0, waitingPulls - 1);
        deliver();
      });
    },
  }, { highWaterMark: 0 });

  return {
    async emit(event) {
      if (failed !== undefined) throw failed;
      if (closed && event.type !== 'complete') {
        throw new AgentContractError('handoff-required', 'The render is complete; later work requires a new invocation handoff');
      }
      while (buffer.length >= 1) {
        if (signal.aborted) throw abortError();
        await space.wait();
      }
      buffer.push(event);
      if (event.type === 'shell') shellEmitted = true;
      if (event.type === 'complete') closed = true;
      data.notify();
    },
    fail(error) {
      if (failed !== undefined || (closed && buffer.length === 0)) return;
      failed = error;
      closed = true;
      data.notify();
      space.notify();
      flight.notify();
    },
    holdFlight() {
      return shellEmitted && waitingPulls === 0;
    },
    readable,
    async waitForFlightDemand() {
      while (shellEmitted && waitingPulls === 0 && failed === undefined) {
        await flight.wait();
      }
    },
  };
};

const gateFlight = (
  flight: ReadableStream<Uint8Array>,
  live: LiveEventStream,
  signal: AbortSignal,
): ReadableStream<Uint8Array> =>
  flight.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await live.waitForFlightDemand();
      if (signal.aborted) throw abortError();
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 1 }, { highWaterMark: 0 }), { signal });

const nextBoundary = async (
  pending: readonly PendingBoundary[],
  signal: AbortSignal,
): Promise<{ readonly boundary: PendingBoundary; readonly error?: unknown; readonly ok: boolean }> => {
  if (signal.aborted) throw abortError();
  return Promise.race([
    new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(abortError());
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }),
    ...pending.map(async (boundary) => {
      try {
        await boundary.thenable;
        return { boundary, ok: true as const };
      } catch (error) {
        return { boundary, error, ok: false as const };
      }
    }),
  ]);
};

const reconcile = async (
  root: ReactNode,
  sequence: AgentRenderEventSequence,
  live: LiveEventStream,
  signal: AbortSignal,
): Promise<void> => {
  const ids = new Map<string, string>();
  let snapshot = snapshotTree(root, ids);
  await live.emit(sequence.emit({ document: decodeAgentDocument(snapshot.tree), type: 'shell' }));

  while (snapshot.pending.length > 0) {
    if (signal.aborted) throw abortError();
    const settled = await nextBoundary(snapshot.pending, signal);
    if (!settled.ok) {
      const error = renderErrorFrom(settled.error);
      await live.emit(sequence.emit({
        boundaryId: settled.boundary.id,
        error,
        type: 'error',
      }));
    }
    snapshot = snapshotTree(root, ids);
    if (settled.ok) {
      await live.emit(sequence.emit({
        boundaryId: settled.boundary.id,
        document: decodeAgentDocument(snapshot.tree),
        type: 'replace',
      }));
    }
  }

  if (signal.aborted) throw abortError();
  await live.emit(sequence.emit({ document: decodeAgentDocument(snapshot.tree), type: 'complete' }));
};

export interface AgentFlightEventSession {
  readonly live: LiveEventStream;
  readonly readable: ReadableStream<AgentRenderEvent>;
  readonly sequence: AgentRenderEventSequence;
}

export const createAgentFlightEventSession = (
  options: AgentFlightDecodeOptions = {},
): AgentFlightEventSession => {
  const signal = options.signal ?? new AbortController().signal;
  const live = createLiveEventStream(signal);
  return Object.freeze({
    live,
    readable: live.readable,
    sequence: createAgentRenderEventSequence(options.limits),
  });
};

const decodeIntoSession = (
  flight: ReadableStream<Uint8Array>,
  session: AgentFlightEventSession,
  signal: AbortSignal,
): void => {
  ensureAgentFlightManifest();
  void (async () => {
    try {
      if (signal.aborted) throw abortError();
      const node = await createFromReadableStream<ReactNode>(
        gateFlight(flight, session.live, signal),
        { unstable_allowPartialStream: true },
      );
      if (signal.aborted) throw abortError();
      await reconcile(node, session.sequence, session.live, signal);
    } catch (error) {
      session.live.fail(signal.aborted ? abortError() : error);
    }
  })();
};

export const decodeAgentFlightStream = (
  flight: ReadableStream<Uint8Array>,
  options: AgentFlightDecodeOptions & { readonly session?: AgentFlightEventSession } = {},
): ReadableStream<AgentRenderEvent> => {
  const signal = options.signal ?? new AbortController().signal;
  const session = options.session ?? createAgentFlightEventSession({ limits: options.limits, signal });
  decodeIntoSession(flight, session, signal);
  return session.readable;
};
