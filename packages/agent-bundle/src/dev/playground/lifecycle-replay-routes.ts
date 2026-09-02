import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayDiagnosticResult,
  LifecycleReplayRequest,
} from '../../contracts/lifecycles.ts';
import { isRecord } from '../../core/strict-json.ts';
import {
  diagnostic,
  hasOnly,
  isRequestDiagnostic,
  nonemptyString,
  rawPathname,
  readJsonBody,
  requestError,
  responseDiagnostic,
  responseJson as writeJsonResponse,
} from '../http.ts';

type Route = 'list' | 'replay';
type JsonObject = Record<string, unknown>;

export const lifecycleReplayResponseLimit = 16 * 1024 * 1024;

export interface LifecycleReplayRouteService {
  list(): LifecycleListResponse | Promise<LifecycleListResponse>;
  replay(
    request: LifecycleReplayRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LifecycleReplay | LifecycleReplayDiagnosticResult>;
}

export interface LifecycleReplayRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly responseByteLimit?: number;
  readonly service?: LifecycleReplayRouteService;
}

const responseJson = (response: ServerResponse, body: unknown): void =>
  writeJsonResponse(response, body, { destroyIfEnded: true });

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8211', 'Lifecycle replay request has an invalid shape.', 400));
};

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/lifecycles' && !pathname.startsWith('/api/lifecycles/')) return undefined;
  if (pathname === '/api/lifecycles') return 'list';
  if (pathname === '/api/lifecycles/replays') return 'replay';
  throw requestError(diagnostic('AB8210', 'Lifecycle replay route path is not valid.', 400));
};

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) invalidShape();
};

const replayRequest = (value: JsonObject): LifecycleReplayRequest => {
  if (!hasOnly(value, ['binding', 'native', 'source'])) return invalidShape();
  const { binding, native, source } = value;
  if (
    !isRecord(binding)
    || !hasOnly(binding, ['manifestDigest', 'routeId', 'target'])
    || !nonemptyString(binding.manifestDigest)
    || !nonemptyString(binding.routeId)
    || !nonemptyString(binding.target)
    || !isRecord(native)
    || (source !== 'fixture' && source !== 'observed')
  ) return invalidShape();
  return Object.freeze({
    binding: Object.freeze({
      manifestDigest: binding.manifestDigest,
      routeId: binding.routeId,
      target: binding.target,
    }),
    native: Object.freeze({ ...native }),
    source,
  });
};

const replayResponse = (
  result: LifecycleReplay | LifecycleReplayDiagnosticResult,
): Readonly<{ readonly diagnostics: LifecycleReplayDiagnosticResult['diagnostics'] }> | Readonly<{ readonly replay: LifecycleReplay }> =>
  'diagnostics' in result
    ? Object.freeze({ diagnostics: result.diagnostics })
    : Object.freeze({ replay: result });

/** Authenticated foreground boundary for read-only semantic lifecycle replay. */
export class LifecycleReplayRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #responseByteLimit: number;
  readonly #service: LifecycleReplayRouteService | undefined;
  #closed = false;

  constructor(options: LifecycleReplayRoutesOptions) {
    this.#authorize = options.authorize;
    this.#responseByteLimit = options.responseByteLimit ?? lifecycleReplayResponseLimit;
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
    noQuery(request.url);
    try {
      const method = request.method ?? 'GET';
      if (parsed === 'list') {
        if (method !== 'GET') {
          responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
          return true;
        }
        responseJson(response, await service.list());
        return true;
      }
      if (method !== 'POST') {
        responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
        return true;
      }
      const body = await readJsonBody(request, { invalidShape });
      const result = replayResponse(await service.replay(replayRequest(body)));
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.#responseByteLimit) {
        throw requestError(diagnostic('AB8214', 'Lifecycle replay exceeds the 16 MiB response limit.', 413));
      }
      responseJson(response, result);
      return true;
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      throw requestError(diagnostic('AB8212', 'Lifecycle replay operation could not be completed.', 502));
    }
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8212', 'Lifecycle replay routes are not available.', status));
  }
}
