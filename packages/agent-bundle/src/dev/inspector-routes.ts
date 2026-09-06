import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  badRequest,
  diagnostic,
  hasOnly,
  isRequestDiagnostic,
  noQuery,
  rawPathname,
  readJsonBody,
  requestError,
  responseDiagnostic,
  responseJsonOrDestroy,
} from './http.ts';
import type { InspectorLauncherStatus } from './inspector-launcher.ts';

type Route = 'launch' | 'status';

export interface InspectorRouteService {
  launch(): Promise<{ readonly url: string }>;
  status(): InspectorLauncherStatus;
}

export interface InspectorRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench composes the opt-in inspector launcher. */
  readonly service?: InspectorRouteService;
}

const pathError = badRequest('AB8110', 'Inspector route path is not valid.');

const invalidShape = badRequest('AB8111', 'Inspector request has an invalid shape.');

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/inspector' && !pathname.startsWith('/api/inspector/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'inspector') return pathError();
  if (parts.length !== 4) return pathError();
  const kind = parts[3];
  if (kind === 'launch' || kind === 'status') return kind;
  return pathError();
};

/**
 * HTTP boundary for the opt-in standalone MCP Inspector. The browser never
 * selects the child command, environment, or working directory.
 */
export class InspectorRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #service: InspectorRouteService | undefined;
  #closed = false;

  constructor(options: InspectorRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): void {
    this.#closed = true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closed) throw this.#unavailable(503);
    const service = this.#service;
    if (service === undefined) throw this.#unavailable(404);
    try {
      await this.#dispatch(parsed, request, response, service);
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      throw requestError(diagnostic('AB8112', 'MCP Inspector could not be launched.', 502));
    }
    return true;
  }

  async #dispatch(
    parsed: Route,
    request: IncomingMessage,
    response: ServerResponse,
    service: InspectorRouteService,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    noQuery(request.url, invalidShape);
    switch (parsed) {
      case 'status':
        if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
        return responseJsonOrDestroy(response, { status: service.status() });
      case 'launch':
        if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
        if (!hasOnly(await readJsonBody(request, { invalidShape }), [])) invalidShape();
        return responseJsonOrDestroy(response, { url: (await service.launch()).url });
      default: {
        const exhaustive: never = parsed;
        throw new Error(`Unexpected inspector route: ${String(exhaustive)}`);
      }
    }
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8113', 'Inspector routes are not available.', status));
  }
}
