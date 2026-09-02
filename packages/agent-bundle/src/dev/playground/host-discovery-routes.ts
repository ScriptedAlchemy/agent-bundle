import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { HostDiscoveryReport } from '../../contracts/discovery.ts';
import {
  diagnostic,
  rawPathname,
  requestError,
  responseDiagnostic,
  responseJson as writeJsonResponse,
} from '../http.ts';

export const hostDiscoveryResponseLimit = 16 * 1024 * 1024;

export interface HostDiscoveryRouteService {
  discover(): Promise<HostDiscoveryReport>;
}

export interface HostDiscoveryRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly responseByteLimit?: number;
  readonly service?: HostDiscoveryRouteService;
}

const responseJson = (response: ServerResponse, body: unknown): void =>
  writeJsonResponse(response, body, { destroyIfEnded: true });

const matchesDiscoveryRoute = (requestTarget: string | undefined): boolean => {
  const pathname = rawPathname(requestTarget);
  if (pathname === '/api/discovery') return true;
  if (pathname.startsWith('/api/discovery/')) {
    throw requestError(diagnostic('AB8215', 'Host discovery route path is not valid.', 400));
  }
  return false;
};

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) {
    throw requestError(diagnostic('AB8216', 'Host discovery request is not valid.', 400));
  }
};

export class HostDiscoveryRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #responseByteLimit: number;
  readonly #service: HostDiscoveryRouteService | undefined;
  #closed = false;

  constructor(options: HostDiscoveryRoutesOptions) {
    this.#authorize = options.authorize;
    this.#responseByteLimit = options.responseByteLimit ?? hostDiscoveryResponseLimit;
    this.#service = options.service;
  }

  close(): void {
    this.#closed = true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!matchesDiscoveryRoute(request.url)) return false;
    this.#authorize(request);
    if (this.#closed || this.#service === undefined) {
      throw requestError(diagnostic('AB8218', 'Host discovery is not available.', 503));
    }
    noQuery(request.url);
    const method = request.method ?? 'GET';
    if (method !== 'GET') {
      responseDiagnostic(response, diagnostic('AB8216', 'Host discovery request is not valid.', 405));
      return true;
    }
    const report = await this.#service.discover();
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > this.#responseByteLimit) {
      throw requestError(diagnostic('AB8217', 'Host discovery exceeds the 16 MiB response limit.', 413));
    }
    responseJson(response, report);
    return true;
  }
}
