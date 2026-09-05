import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  diagnostic,
  rawPathname,
  requestError,
  responseDiagnostic,
  responseJson,
  type RequestDiagnostic,
} from '../http.ts';
import { createBackpressuredWriter, encodedNdjsonFrame, writeKeepAliveStreamHead } from '../route-streams.ts';
import {
  TraceHubError,
  type TraceHub,
  type TraceSubscription,
} from './trace-hub.ts';
import type { TraceMessage } from './trace-entry.ts';

const streamQueueByteLimit = 256 * 1024;
const streamQueueEntryLimit = 128;

type Route = 'replay' | 'stream';

export interface TraceRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly hub?: TraceHub;
}

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname === '/api/trace') return 'replay';
  if (pathname === '/api/trace/stream') return 'stream';
  return undefined;
};

const cursor = (requestTarget: string | undefined): number => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'after') || query.getAll('after').length > 1) {
    throw requestError(diagnostic('AB8240', 'Trace cursor is not valid.', 400));
  }
  const value = query.get('after');
  if (value === null) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw requestError(diagnostic('AB8240', 'Trace cursor is not valid.', 400));
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw requestError(diagnostic('AB8240', 'Trace cursor is not valid.', 400));
  }
  return parsed;
};

const mappedHubError = (error: unknown): RequestDiagnostic | undefined => {
  if (!(error instanceof TraceHubError)) return undefined;
  switch (error.code) {
    case 'TRACE_CURSOR_INVALID':
      return diagnostic('AB8240', 'Trace cursor is not valid.', 400);
    case 'TRACE_CURSOR_AHEAD':
      return diagnostic('AB8241', 'Trace cursor is ahead of retained history.', 409);
    case 'TRACE_HUB_CLOSED':
      return diagnostic('AB8242', 'Trace routes are not available.', 503);
    default: {
      const exhausted: never = error.code;
      throw new Error(`Unhandled TraceHub error code: ${String(exhausted)}`);
    }
  }
};

/** Authenticated replay and backpressured NDJSON transport for the unified trace. */
export class TraceRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #closeStreams = new Set<() => Promise<void>>();
  readonly #hub: TraceHub | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: TraceRoutesOptions) {
    this.#authorize = options.authorize;
    this.#hub = options.hub;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.#closeStreams].map(async (close) => close()));
      this.#closeStreams.clear();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((failure) => failure.reason), 'Trace streams could not close.');
      }
    });
    return this.#closePromise;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closePromise !== undefined) {
      throw requestError(diagnostic('AB8242', 'Trace routes are not available.', 503));
    }
    const hub = this.#hub;
    if (hub === undefined) throw requestError(diagnostic('AB8242', 'Trace routes are not available.', 404));
    if ((request.method ?? 'GET') !== 'GET') {
      responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return true;
    }
    try {
      const afterSequence = cursor(request.url);
      if (parsed === 'replay') {
        responseJson(response, hub.replay({ afterSequence }), { destroyIfEnded: true });
      } else {
        this.#stream(hub, afterSequence, response);
      }
    } catch (error) {
      const mapped = mappedHubError(error);
      if (mapped !== undefined) throw requestError(mapped);
      if (error instanceof Error && 'status' in error) throw error;
      throw requestError(diagnostic('AB8242', 'Trace routes are not available.', 503));
    }
    return true;
  }

  #stream(hub: TraceHub, afterSequence: number, response: ServerResponse): void {
    hub.replay({ afterSequence });
    const writer = createBackpressuredWriter(response, {
      byteLimit: streamQueueByteLimit,
      recordLimit: streamQueueEntryLimit,
    });
    const stream = { subscription: undefined as TraceSubscription | undefined };
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      writer.markClosed();
      stream.subscription?.close();
      this.#closeStreams.delete(close);
      response.off('close', closeFromPeer);
      closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
        if (response.destroyed || response.writableEnded) {
          resolvePromise();
          return;
        }
        let settled = false;
        const settle = (error?: Error): void => {
          if (settled) return;
          settled = true;
          response.off('finish', onFinish);
          response.off('close', onClose);
          response.off('error', onError);
          if (error === undefined) resolvePromise();
          else rejectPromise(error);
        };
        const onFinish = (): void => settle();
        const onClose = (): void => settle();
        const onError = (error: Error): void => settle(error);
        response.once('finish', onFinish);
        response.once('close', onClose);
        response.once('error', onError);
        try {
          response.end();
        } catch (error) {
          settle(error instanceof Error ? error : new Error('Trace stream could not close.'));
        }
      });
      return closePromise;
    };
    const closeFromPeer = (): void => { void close(); };
    const closeSlow = (): boolean => {
      void close();
      response.destroy();
      return false;
    };
    const deliver = (message: TraceMessage): boolean => {
      const result = writer.enqueue(encodedNdjsonFrame(message));
      if (result === 'overflow') return closeSlow();
      return result !== 'closed';
    };
    this.#closeStreams.add(close);
    response.once('close', closeFromPeer);
    writeKeepAliveStreamHead(response, {
      cacheControl: 'no-cache',
      contentType: 'application/x-ndjson; charset=utf-8',
    });
    stream.subscription = hub.subscribe(deliver, { afterSequence });
    if (writer.closed || stream.subscription.closed) void close();
  }
}
