import {
  AgentContractError,
  agentRenderAbortError,
  type AgentDocument,
  type AgentRenderEvent,
  type AgentRenderLimits,
} from './agent-document.js';
import type { AgentProgressReporter, AgentRenderInvocation } from './agent-request.js';
import { createFlightDemand } from './effect/render-stream.js';
import { createAgentRenderEventSession, toPublicEventStream } from './reconciler.js';

export { decodeAgentDocument } from './decode-document.js';

export interface AgentRenderDispatch {
  readonly artifactEpoch?: string;
  readonly invocation: AgentRenderInvocation;
  /**
   * Per-dispatch render limits layered over the dispatcher's own: the route's
   * declared render budget (`config.render.maxElapsedMs`) travels here, so one
   * long-lived dispatcher serves routes with different budgets.
   */
  readonly limits?: Partial<AgentRenderLimits>;
  readonly progress?: AgentProgressReporter;
  readonly signal: AbortSignal;
}

export interface AgentFlightExecutionHost {
  readonly execute: (request: AgentRenderDispatch) => Promise<ReadableStream<Uint8Array>>;
}

export interface AgentRenderDispatcher {
  readonly dispatch: (request: AgentRenderDispatch) => Promise<AgentDocument>;
  readonly stream: (request: AgentRenderDispatch) => ReadableStream<AgentRenderEvent>;
}

export interface AgentRenderDispatcherOptions {
  readonly limits?: Partial<AgentRenderLimits>;
}

const abortError = agentRenderAbortError;

const abortedStream = (): ReadableStream<AgentRenderEvent> =>
  new ReadableStream({
    start(controller) {
      controller.error(abortError());
    },
  });

const drainCompleteDocument = async (
  events: ReadableStream<AgentRenderEvent>,
  signal: AbortSignal,
): Promise<AgentDocument> => {
  const reader = events.getReader();
  let complete: AgentDocument | undefined;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      switch (next.value.type) {
        case 'complete':
          complete = next.value.document;
          break;
        case 'shell':
        case 'progress':
        case 'replace':
        case 'error':
          break;
        default: {
          const exhaustive: never = next.value;
          return exhaustive;
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  }
  if (complete !== undefined) return complete;
  if (signal.aborted) throw abortError();
  throw new AgentContractError('invalid-document', 'Flight stream ended without a complete document');
};

export const createAgentRenderDispatcher = (
  host: AgentFlightExecutionHost,
  options: AgentRenderDispatcherOptions = {},
): AgentRenderDispatcher => {
  const stream = (request: AgentRenderDispatch): ReadableStream<AgentRenderEvent> => {
    if (request.signal.aborted) return abortedStream();
    const demand = createFlightDemand();
    const pendingFlight: { current?: Promise<ReadableStream<Uint8Array>> } = {};
    const session = createAgentRenderEventSession({
      demand,
      get flight() {
        const current = pendingFlight.current;
        if (current === undefined) {
          return Promise.reject(new AgentContractError('invalid-document', 'Flight worker is not running'));
        }
        return current;
      },
      limits: { ...options.limits, ...request.limits },
      signal: request.signal,
    });
    const rememberFlight = (flight: Promise<ReadableStream<Uint8Array>>): Promise<ReadableStream<Uint8Array>> => {
      void flight.catch(() => undefined);
      return flight;
    };
    try {
      pendingFlight.current = rememberFlight(host.execute({
        ...(request.artifactEpoch === undefined ? {} : { artifactEpoch: request.artifactEpoch }),
        invocation: request.invocation,
        progress: session.progress,
        signal: request.signal,
      }));
    } catch (error) {
      pendingFlight.current = rememberFlight(Promise.reject(request.signal.aborted ? abortError() : error));
    }
    return toPublicEventStream(session.events, demand, request.signal);
  };

  return Object.freeze({
    async dispatch(request: AgentRenderDispatch): Promise<AgentDocument> {
      return drainCompleteDocument(stream(request), request.signal);
    },
    stream,
  });
};
