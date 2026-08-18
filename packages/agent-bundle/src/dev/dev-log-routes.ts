import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DevLogServiceError,
  type DevLogMessage,
  type DevLogReplay,
  type DevLogService,
  type DevLogSubscription,
} from './dev-log-service.ts';

const streamQueueByteLimit = 256 * 1024;
const streamQueueRecordLimit = 128;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

interface QueuedFrame {
  readonly bytes: number;
  readonly frame: string;
}

type Route = 'replay' | 'stream';

export interface DevLogRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly service?: DevLogService;
}

const diagnostic = (code: string, message: string, status: number): RequestDiagnostic => ({ code, message, status });

const requestError = (value: RequestDiagnostic): RequestDiagnostic & Error => Object.assign(new Error(value.message), value);

const responseDiagnostic = (response: ServerResponse, value: RequestDiagnostic): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(value.status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ diagnostic: { code: value.code, message: value.message } }));
};

const responseJson = (response: ServerResponse, body: unknown): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const rawPathname = (requestTarget: string | undefined): string => requestTarget?.split(/[?#]/u, 1)[0] ?? '';

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
  readonly #closeStreams = new Set<() => void>();
  readonly #service: DevLogService | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: DevLogRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(() => {
      for (const close of this.#closeStreams) close();
      this.#closeStreams.clear();
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
    let backpressured = false;
    let closed = false;
    let queuedBytes = 0;
    const queued: QueuedFrame[] = [];
    const stream = { subscription: undefined as DevLogSubscription | undefined };
    const close = (): void => {
      if (closed) return;
      closed = true;
      stream.subscription?.close();
      queued.length = 0;
      queuedBytes = 0;
      this.#closeStreams.delete(close);
    };
    const closeSlow = (): boolean => {
      close();
      response.destroy();
      return false;
    };
    const drain = (): void => {
      if (closed || response.destroyed || response.writableEnded) return;
      backpressured = false;
      while (queued.length > 0) {
        const next = queued.shift();
        if (next === undefined) continue;
        queuedBytes -= next.bytes;
        if (!response.write(next.frame)) {
          backpressured = true;
          response.once('drain', drain);
          return;
        }
      }
    };
    const deliver = (message: DevLogMessage): boolean => {
      if (closed || response.destroyed || response.writableEnded) return false;
      const frame = `${JSON.stringify(message)}\n`;
      const bytes = Buffer.byteLength(frame, 'utf8');
      if (!backpressured) {
        if (!response.write(frame)) {
          backpressured = true;
          response.once('drain', drain);
        }
        return true;
      }
      if (queued.length >= streamQueueRecordLimit || queuedBytes + bytes > streamQueueByteLimit) return closeSlow();
      queued.push(Object.freeze({ bytes, frame }));
      queuedBytes += bytes;
      return true;
    };
    this.#closeStreams.add(close);
    response.once('close', close);
    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'application/x-ndjson; charset=utf-8',
    });
    response.flushHeaders();
    stream.subscription = service.subscribe({ afterSequence }, deliver);
    if (closed) stream.subscription.close();
  }
}

export type { DevLogReplay };
