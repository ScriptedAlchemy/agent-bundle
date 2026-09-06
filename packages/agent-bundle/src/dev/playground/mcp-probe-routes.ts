import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpProbeHost, McpProbeReport } from '../../contracts/mcp-probe.ts';
import {
  badRequest,
  diagnostic,
  hasOnly,
  isRequestDiagnostic,
  noQuery,
  nonemptyString,
  rawPathname,
  readJsonBody,
  requestError,
  responseDiagnostic,
  responseJsonOrDestroy,
} from '../http.ts';
import { McpProbeTargetNotFoundError } from './mcp-probe-service.ts';

export const mcpProbeResponseLimit = 16 * 1024 * 1024;

export interface McpProbeRouteService {
  probe(options: {
    readonly host: McpProbeHost;
    readonly serverName: string;
  }): Promise<McpProbeReport>;
}

export interface McpProbeRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly responseByteLimit?: number;
  readonly service?: McpProbeRouteService;
}

const matchesProbeRoute = (requestTarget: string | undefined): boolean => {
  const pathname = rawPathname(requestTarget);
  if (pathname === '/api/discovery/probes') return true;
  if (pathname.startsWith('/api/discovery/probes/')) {
    throw requestError(diagnostic('AB8219', 'MCP probe route path is not valid.', 400));
  }
  return false;
};

const invalidRequest = badRequest('AB8220', 'MCP probe request is not valid.');

const isHost = (value: unknown): value is McpProbeHost =>
  value === 'claude' || value === 'codex' || value === 'cursor';

const probeRequest = async (
  request: IncomingMessage,
): Promise<{ readonly host: McpProbeHost; readonly serverName: string }> => {
  const body = await readJsonBody(request, { invalidShape: invalidRequest });
  if (!hasOnly(body, ['host', 'serverName']) || Object.keys(body).length !== 2) {
    return invalidRequest();
  }
  const host = body.host;
  const serverName = body.serverName;
  if (!isHost(host) || !nonemptyString(serverName) || serverName.length > 256) {
    return invalidRequest();
  }
  return Object.freeze({ host, serverName });
};

export class McpProbeRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #responseByteLimit: number;
  readonly #service: McpProbeRouteService | undefined;
  #closed = false;

  constructor(options: McpProbeRoutesOptions) {
    this.#authorize = options.authorize;
    this.#responseByteLimit = options.responseByteLimit ?? mcpProbeResponseLimit;
    this.#service = options.service;
  }

  close(): void {
    this.#closed = true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!matchesProbeRoute(request.url)) return false;
    this.#authorize(request);
    if (this.#closed || this.#service === undefined) {
      throw requestError(diagnostic('AB8223', 'MCP probing is not available.', 503));
    }
    const method = request.method ?? 'GET';
    if (method !== 'POST') {
      responseDiagnostic(response, diagnostic('AB8220', 'MCP probe request is not valid.', 405));
      return true;
    }
    noQuery(request.url, invalidRequest);
    let report: McpProbeReport;
    try {
      report = await this.#service.probe(await probeRequest(request));
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      if (error instanceof McpProbeTargetNotFoundError) {
        throw requestError(diagnostic('AB8221', error.message, 404));
      }
      throw requestError(diagnostic('AB8220', 'MCP probe could not be completed.', 502));
    }
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > this.#responseByteLimit) {
      throw requestError(diagnostic('AB8222', 'MCP probe exceeds the 16 MiB response limit.', 413));
    }
    responseJsonOrDestroy(response, report);
    return true;
  }
}
