import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  diagnostic,
  isRequestDiagnostic,
  rawPathname,
  requestError,
  responseDiagnostic,
  responseJson as writeJsonResponse,
} from '../http.ts';
import type { RouteManifest } from './route-manifest.ts';

export interface RouteManifestRouteService {
  /**
   * The manifest of the latest valid compiler pass. Throws when no valid
   * project has been prepared yet, which the boundary reports as unavailable
   * instead of inventing an empty catalog.
   */
  manifest(): RouteManifest;
}

export interface RouteManifestRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench composes a prepared-project manifest source. */
  readonly service?: RouteManifestRouteService;
}

const responseJson = (response: ServerResponse, body: unknown): void =>
  writeJsonResponse(response, body, { destroyIfEnded: true });

const pathError = (): never => {
  throw requestError(diagnostic('AB8120', 'Route manifest path is not valid.', 400));
};

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8122', 'Route manifest request has an invalid shape.', 400));
};

const isManifestRoute = (requestTarget: string | undefined): boolean => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/routes' && !pathname.startsWith('/api/routes/')) return false;
  const parts = pathname.split('/');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'routes' || parts[3] !== 'manifest') {
    return pathError();
  }
  return true;
};

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) invalidShape();
};

/**
 * Read-only HTTP boundary over the compiled route graph. The browser names no
 * path, mode, or revision: the manifest of the latest valid compiler pass is
 * the whole request, so the Workbench cannot ask for a second discovery.
 */
export class RouteManifestRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #service: RouteManifestRouteService | undefined;
  #closed = false;

  constructor(options: RouteManifestRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): void {
    this.#closed = true;
  }

  /** Synchronous by construction: the manifest is already in memory, so this boundary performs no I/O. */
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    if (!isManifestRoute(request.url)) return false;
    this.#authorize(request);
    if (this.#closed) throw this.#unavailable(503);
    const service = this.#service;
    if (service === undefined) throw this.#unavailable(404);
    if ((request.method ?? 'GET') !== 'GET') {
      responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return true;
    }
    noQuery(request.url);
    let manifest: RouteManifest;
    try {
      manifest = service.manifest();
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      throw this.#unavailable(409);
    }
    responseJson(response, { manifest });
    return true;
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8121', 'Route manifest is not available.', status));
  }
}
