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

const invalidShape = badRequest('AB8211', 'Lifecycle replay request has an invalid shape.');

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/lifecycles' && !pathname.startsWith('/api/lifecycles/')) return undefined;
  if (pathname === '/api/lifecycles') return 'list';
  if (pathname === '/api/lifecycles/replays') return 'replay';
  throw requestError(diagnostic('AB8210', 'Lifecycle replay route path is not valid.', 400));
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

const requestAbort = (
  request: IncomingMessage,
  response: ServerResponse,
): Readonly<{ readonly dispose: () => void; readonly signal: AbortSignal }> => {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('Lifecycle replay request was cancelled.'));
  };
  const abortResponse = (): void => {
    if (!response.writableEnded) abort();
  };
  request.once('aborted', abort);
  response.once('close', abortResponse);
  return Object.freeze({
    dispose: () => {
      request.removeListener('aborted', abort);
      response.removeListener('close', abortResponse);
    },
    signal: controller.signal,
  });
};

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
    noQuery(request.url, invalidShape);
    try {
      const method = request.method ?? 'GET';
      if (parsed === 'list') {
        if (method !== 'GET') {
          responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
          return true;
        }
        responseJsonOrDestroy(response, await service.list());
        return true;
      }
      if (method !== 'POST') {
        responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
        return true;
      }
      const body = await readJsonBody(request, { invalidShape });
      const cancellation = requestAbort(request, response);
      let result: ReturnType<typeof replayResponse>;
      try {
        result = replayResponse(await service.replay(replayRequest(body), { signal: cancellation.signal }));
      } finally {
        cancellation.dispose();
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.#responseByteLimit) {
        throw requestError(diagnostic('AB8214', 'Lifecycle replay exceeds the 16 MiB response limit.', 413));
      }
      responseJsonOrDestroy(response, result);
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
