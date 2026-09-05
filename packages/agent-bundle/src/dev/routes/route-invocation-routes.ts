import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectEventHub } from '../events.ts';
import {
  decodedOpaqueSegment,
  diagnostic,
  rawPathname,
  readJsonBody,
  requestError,
  responseDiagnostic,
  responseJson,
} from '../http.ts';
import type {
  RouteInvocation,
  RouteInvocationListResponse,
  RouteInvocationRequest,
  RouteInvocationResponse,
} from './route-invocation.ts';
import {
  invocationSummary,
  parseRouteInvocationRequest,
  ROUTE_INVOCATION_CHILD_FAILURE_CODE,
  ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
  type RouteInvocationRequestError,
} from './route-invocation-service.ts';

export interface RouteInvocationRouteService {
  close?(): Promise<void> | void;
  invoke(request: RouteInvocationRequest): Promise<RouteInvocation>;
  list(limit?: number): RouteInvocationListResponse['invocations'];
  read(id: string): RouteInvocation | undefined;
}

export interface RouteInvocationRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly eventHub: ProjectEventHub;
  readonly service?: RouteInvocationRouteService;
}

type InvocationPath =
  | Readonly<{ readonly kind: 'collection' }>
  | Readonly<{ readonly id: string; readonly kind: 'item' }>;

const invocationPath = (requestTarget: string | undefined): InvocationPath | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/routes/invocations' && !pathname.startsWith('/api/routes/invocations/')) return undefined;
  if (pathname === '/api/routes/invocations') return Object.freeze({ kind: 'collection' });
  const parts = pathname.split('/');
  if (parts.length !== 5 || parts[4] === undefined) {
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
    kind: 'item',
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

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) {
    throw requestError(diagnostic(
      ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
      'Route invocation request has an invalid shape.',
      400,
    ));
  }
};

const unavailable = (): never => {
  throw requestError(diagnostic('AB8232', 'Route invocation service is not available.', 409));
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
      noQuery(request.url);
      const body = await readJsonBody(request, {
        invalidShape: () => {
          throw requestError(diagnostic(
            ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
            'Route invocation request has an invalid shape.',
            400,
          ));
        },
        read: {
          code: ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
          limit: 64 * 1024,
          message: 'Route invocation request exceeds 64 KiB.',
        },
      });
      let invocation: RouteInvocation;
      try {
        invocation = await service.invoke(parseRouteInvocationRequest(body));
      } catch (error) {
        const failure = error as Partial<RouteInvocationRequestError>;
        if (typeof failure.code === 'string' && typeof failure.message === 'string' && typeof failure.status === 'number') {
          throw requestError(diagnostic(failure.code, failure.message, failure.status));
        }
        throw error;
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
    if (path.kind === 'item' && method === 'GET') {
      noQuery(request.url);
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
}
