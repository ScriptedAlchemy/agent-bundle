import {
  AgentContractError,
  type AgentDocument,
  type AgentRenderEvent,
  type AgentRenderLimits,
} from './agent-document.js';
import type { AgentProgressReporter, AgentProgressUpdate, AgentRenderInvocation } from './agent-request.js';
import { createAgentFlightEventSession, decodeAgentFlightStream } from './reconciler.js';

export { decodeAgentDocument } from './decode-document.js';

export interface AgentRenderDispatch {
  readonly invocation: AgentRenderInvocation;
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

const abortError = (): DOMException => new DOMException('Agent render was aborted', 'AbortError');

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
    if (request.signal.aborted) {
      return new ReadableStream({
        start(controller) {
          controller.error(abortError());
        },
      });
    }
    const session = createAgentFlightEventSession({ limits: options.limits, signal: request.signal });
    const progress: AgentProgressReporter = Object.freeze({
      report: async (update: AgentProgressUpdate) => {
        await session.live.emit(session.sequence.emit({
          completed: update.completed ?? 0,
          ...(update.message === undefined ? {} : { message: update.message }),
          ...(update.total === undefined ? {} : { total: update.total }),
          type: 'progress',
        }));
      },
    });
    void (async () => {
      try {
        if (request.signal.aborted) throw abortError();
        const flight = await host.execute({
          invocation: request.invocation,
          progress,
          signal: request.signal,
        });
        if (request.signal.aborted) throw abortError();
        decodeAgentFlightStream(flight, {
          limits: options.limits,
          session,
          signal: request.signal,
        });
      } catch (error) {
        session.live.fail(request.signal.aborted ? abortError() : error);
      }
    })();
    return session.readable;
  };

  return Object.freeze({
    async dispatch(request: AgentRenderDispatch): Promise<AgentDocument> {
      return drainCompleteDocument(stream(request), request.signal);
    },
    stream,
  });
};
