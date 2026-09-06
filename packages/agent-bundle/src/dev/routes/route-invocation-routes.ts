import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectEventHub } from '../events.ts';
import {
  createBackpressuredWriter,
  writeKeepAliveStreamHead,
} from '../route-streams.ts';
import {
  badRequest,
  decodedOpaqueSegment,
  diagnostic,
  noQuery,
  rawPathname,
  readJsonBody,
  requestError,
  responseDiagnostic,
  responseJson,
} from '../http.ts';
import type {
  RouteInvocation,
  RouteInvocationResponse,
  RouteInvocationStart,
  RouteInvocationStreamMessage,
  RunningRouteInvocationResponse,
} from './route-invocation-result.ts';
import type {
  RouteInvocationListResponse,
  RouteInvocationRequest,
} from './route-invocation.ts';
import {
  invocationSummary,
  parseRouteInvocationRequest,
  ROUTE_INVOCATION_CHILD_FAILURE_CODE,
  ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
  type RouteInvocationRequestError,
} from './route-invocation-service.ts';

const streamQueueByteLimit = 256 * 1024;
const streamQueueEntryLimit = 128;
const invalidShape = badRequest(
  ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
  'Route invocation request has an invalid shape.',
);

export interface RouteInvocationRouteService {
  close?(): Promise<void> | void;
  invoke(
    request: RouteInvocationRequest,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<RouteInvocation>;
  cancel(id: string): Promise<RouteInvocation>;
  has(id: string): boolean;
  list(limit?: number): RouteInvocationListResponse['invocations'];
  read(id: string): RouteInvocation | undefined;
  start(
    request: RouteInvocationRequest,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): RouteInvocationStart;
  subscribe(id: string, listener: (message: RouteInvocationStreamMessage) => void): () => void;
}

export interface RouteInvocationRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly eventHub: ProjectEventHub;
  readonly service?: RouteInvocationRouteService;
}

type InvocationPath =
  | Readonly<{ readonly kind: 'collection' }>
  | Readonly<{ readonly id: string; readonly kind: 'item' | 'stream' | 'cancel' }>;

const invocationPath = (requestTarget: string | undefined): InvocationPath | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/routes/invocations' && !pathname.startsWith('/api/routes/invocations/')) return undefined;
  if (pathname === '/api/routes/invocations') return Object.freeze({ kind: 'collection' });
  const parts = pathname.split('/');
  if ((parts.length !== 5 && parts.length !== 6) || parts[4] === undefined) {
    throw requestError(diagnostic(
      ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
      'Route invocation path is not valid.',
      400,
    ));
  }
  if (parts.length === 6 && parts[5] !== 'stream' && parts[5] !== 'cancel') {
    throw requestError(diagnostic(
      ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
      'Route invocation path is not valid.',
      400,
    ));
  }
  return Object.freeze({
    id: decodedOpaqueSegment(parts[4], {
      code: ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
      maxLength: 128,
      message: 'Route invocation path is not valid.',
      rejectBlank: true,
    }),
    kind: parts.length === 5 ? 'item' : parts[5] as 'cancel' | 'stream',
  });
};

const listLimit = (requestTarget: string | undefined): number => {
  const values = new URL(requestTarget ?? '/', 'http://localhost').searchParams.getAll('limit');
  if (values.length === 0) return 50;
  const [value] = values;
  if (values.length !== 1 || value === undefined || !/^[1-9]\d*$/u.test(value)) {
    throw requestError(diagnostic(
      ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
      'Route invocation list limit must be one integer between 1 and 200.',
      400,
    ));
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 200) {
    throw requestError(diagnostic(
      ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
      'Route invocation list limit must be one integer between 1 and 200.',
      400,
    ));
  }
  return limit;
};

const unavailable = (): never => {
  throw requestError(diagnostic('AB8232', 'Route invocation service is not available.', 409));
};

const throwInvocationError = (error: unknown): never => {
  const failure = error as Partial<RouteInvocationRequestError>;
  if (typeof failure.code === 'string' && typeof failure.message === 'string' && typeof failure.status === 'number') {
    throw requestError(diagnostic(failure.code, failure.message, failure.status));
  }
  throw error;
};

export class RouteInvocationRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #eventHub: ProjectEventHub;
  readonly #service: RouteInvocationRouteService | undefined;
  #closed = false;

  constructor(options: RouteInvocationRoutesOptions) {
    this.#authorize = options.authorize;
    this.#eventHub = options.eventHub;
    this.#service = options.service;
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve(this.#service?.close?.());
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = invocationPath(request.url);
    if (path === undefined) return false;
    this.#authorize(request);
    if (this.#closed) return unavailable();
    const service = this.#service;
    if (service === undefined) return unavailable();
    const method = request.method ?? 'GET';
    if (path.kind === 'collection' && method === 'POST') {
      noQuery(request.url, invalidShape);
      const body = await readJsonBody(request, {
        invalidShape,
        read: {
          code: ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
          limit: 64 * 1024,
          message: 'Route invocation request exceeds 64 KiB.',
        },
      });
      if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        throw requestError(diagnostic(
          ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
          'Route invocation request has an invalid shape.',
          400,
        ));
      }
      const { stream, ...requestBody } = body;
      if (stream === true) {
        let started: RouteInvocationStart;
        try {
          started = service.start(parseRouteInvocationRequest(requestBody));
        } catch (error) {
          return throwInvocationError(error);
        }
        this.#eventHub.publish({
          payload: { invocation: started.invocation },
          type: 'route.invocation',
        });
        void started.result.then((invocation) => {
          this.#eventHub.publish({
            payload: { invocation: invocationSummary(invocation) },
            type: 'route.invocation',
          });
        }, () => undefined);
        responseJson(response, { invocation: started.invocation } satisfies RunningRouteInvocationResponse, { status: 202 });
        return true;
      }
      let invocation: RouteInvocation;
      const controller = new AbortController();
      const cancel = (): void => controller.abort(new DOMException('Route invocation request was cancelled.', 'AbortError'));
      request.once('aborted', cancel);
      response.once('close', cancel);
      try {
        if (response.destroyed) cancel();
        invocation = await service.invoke(parseRouteInvocationRequest(body), { signal: controller.signal });
      } catch (error) {
        return throwInvocationError(error);
      } finally {
        request.off('aborted', cancel);
        response.off('close', cancel);
      }
      this.#eventHub.publish({
        payload: { invocation: invocationSummary(invocation) },
        type: 'route.invocation',
      });
      const bodyResponse: RouteInvocationResponse = { invocation };
      responseJson(response, bodyResponse, {
        status: invocation.diagnostics.some((entry) => entry.code === ROUTE_INVOCATION_CHILD_FAILURE_CODE)
          && invocation.diagnostics[0]?.message.includes('timed out')
          ? 503
          : 200,
      });
      return true;
    }
    if (path.kind === 'collection' && method === 'GET') {
      responseJson(response, { invocations: service.list(listLimit(request.url)) } satisfies RouteInvocationListResponse);
      return true;
    }
    if (path.kind === 'stream' && method === 'GET') {
      noQuery(request.url, invalidShape);
      if (!service.has(path.id)) {
        throw requestError(diagnostic('AB8231', `Route invocation ${JSON.stringify(path.id)} was not found.`, 404));
      }
      this.#stream(service, path.id, response);
      return true;
    }
    if (path.kind === 'cancel' && method === 'POST') {
      noQuery(request.url, invalidShape);
      try {
        const invocation = await service.cancel(path.id);
        responseJson(response, { invocation } satisfies RouteInvocationResponse, { status: 202 });
      } catch (error) {
        return throwInvocationError(error);
      }
      return true;
    }
    if (path.kind === 'item' && method === 'GET') {
      noQuery(request.url, invalidShape);
      const invocation = service.read(path.id);
      if (invocation === undefined) {
        throw requestError(diagnostic('AB8231', `Route invocation ${JSON.stringify(path.id)} was not found.`, 404));
      }
      responseJson(response, { invocation } satisfies RouteInvocationResponse);
      return true;
    }
    responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    return true;
  }

  #stream(service: RouteInvocationRouteService, id: string, response: ServerResponse): void {
    let terminal = false;
    const stream = { unsubscribe: undefined as (() => void) | undefined };
    const finish = (): void => {
      if (!terminal || !writer.idle || response.writableEnded || response.destroyed) return;
      stream.unsubscribe?.();
      response.end();
    };
    const writer = createBackpressuredWriter(response, {
      byteLimit: streamQueueByteLimit,
      onIdle: finish,
      recordLimit: streamQueueEntryLimit,
    });
    const deliver = (message: RouteInvocationStreamMessage): void => {
      const result = writer.enqueue(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
      if (result === 'overflow') response.destroy();
      if (message.type === 'final') terminal = true;
      finish();
    };
    response.once('close', () => {
      writer.markClosed();
      stream.unsubscribe?.();
    });
    writeKeepAliveStreamHead(response, {
      cacheControl: 'no-cache',
      contentType: 'text/event-stream; charset=utf-8',
    });
    stream.unsubscribe = service.subscribe(id, deliver);
    finish();
  }
}
