import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DevLogServiceError,
  type DevLogMessage,
  type DevLogReplay,
  type DevLogService,
  type DevLogSubscription,
} from './dev-log-service.ts';
import {
  diagnostic,
  rawPathname,
  requestError,
  responseDiagnostic,
  responseJson as writeJsonResponse,
  type RequestDiagnostic,
} from '../http.ts';
import { createBackpressuredWriter, encodedNdjsonFrame, writeKeepAliveStreamHead } from '../route-streams.ts';

const streamQueueByteLimit = 256 * 1024;
const streamQueueRecordLimit = 128;

type Route = 'replay' | 'stream';

export interface DevLogRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly service?: DevLogService;
}

const responseJson = (response: ServerResponse, body: unknown): void =>
  writeJsonResponse(response, body, { destroyIfEnded: true });

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/logs' && !pathname.startsWith('/api/logs/')) return undefined;
  if (pathname === '/api/logs/replay') return 'replay';
  if (pathname === '/api/logs/stream') return 'stream';
  throw requestError(diagnostic('AB8090', 'Dev Log route path is not valid.', 400));
};

const cursor = (requestTarget: string | undefined): number => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'after') || query.getAll('after').length > 1) {
    throw requestError(diagnostic('AB8091', 'Dev Log cursor is not valid.', 400));
  }
  const value = query.get('after');
  if (value === null) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(value)) throw requestError(diagnostic('AB8091', 'Dev Log cursor is not valid.', 400));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw requestError(diagnostic('AB8091', 'Dev Log cursor is not valid.', 400));
  return parsed;
};

const mappedServiceError = (error: unknown): RequestDiagnostic | undefined => {
  if (!(error instanceof DevLogServiceError)) return undefined;
  if (error.code === 'DEV_LOG_CURSOR_INVALID') return diagnostic('AB8091', 'Dev Log cursor is not valid.', 400);
  if (error.code === 'DEV_LOG_CURSOR_AHEAD') return diagnostic('AB8092', 'Dev Log cursor is ahead of retained history.', 409);
  return diagnostic('AB8093', 'Dev Log routes are not available.', 503);
};

/**
 * Authenticated replay and NDJSON transport for the producer-wide Dev Log.
 * Validation happens before stream headers so a bad cursor remains a normal
 * diagnostic response rather than a partially-opened connection.
 */
export class DevLogRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #closeStreams = new Set<() => Promise<void>>();
  readonly #service: DevLogService | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: DevLogRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.#closeStreams].map(async (close) => close()));
      this.#closeStreams.clear();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), 'Dev Log streams could not close.');
    });
    return this.#closePromise;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closePromise !== undefined) throw requestError(diagnostic('AB8093', 'Dev Log routes are not available.', 503));
    const service = this.#service;
    if (service === undefined) throw requestError(diagnostic('AB8093', 'Dev Log routes are not available.', 404));
    if ((request.method ?? 'GET') !== 'GET') {
      responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return true;
    }
    try {
      const afterSequence = cursor(request.url);
      if (parsed === 'replay') {
        responseJson(response, { replay: service.replay({ afterSequence }) });
      } else {
        this.#stream(service, afterSequence, response);
      }
    } catch (error) {
      const mapped = mappedServiceError(error);
      if (mapped !== undefined) throw requestError(mapped);
      if (error instanceof Error && 'status' in error) throw error;
      throw requestError(diagnostic('AB8093', 'Dev Log routes are not available.', 503));
    }
    return true;
  }

  #stream(service: DevLogService, afterSequence: number, response: ServerResponse): void {
    // This probes the cursor before headers. The immediately following
    // subscription is synchronous, so no producer can create an unobserved gap.
    service.replay({ afterSequence });
    const writer = createBackpressuredWriter(response, {
      byteLimit: streamQueueByteLimit,
      recordLimit: streamQueueRecordLimit,
    });
    const stream = { subscription: undefined as DevLogSubscription | undefined };
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
        try { response.end(); }
        catch (error) { settle(error instanceof Error ? error : new Error('Dev Log stream could not close.')); }
      });
      return closePromise;
    };
    const closeFromPeer = (): void => { void close(); };
    const closeSlow = (): boolean => {
      void close();
      response.destroy();
      return false;
    };
    const deliver = (message: DevLogMessage): boolean => {
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
    stream.subscription = service.subscribe({ afterSequence }, deliver);
    if (writer.closed || stream.subscription.closed) void close();
  }
}

export type { DevLogReplay };
