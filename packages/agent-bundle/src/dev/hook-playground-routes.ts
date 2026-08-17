import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundInput,
  HookPlaygroundListOptions,
  HookPlaygroundReplay,
  HookPlaygroundSimulation,
  HookPlaygroundSimulationOptions,
} from './hook-playground-service.ts';

const bodyLimit = 64 * 1024;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type Route = Readonly<{ readonly kind: 'hooks' | 'simulations' | 'replays' }>;

type JsonObject = Record<string, unknown>;

export type HookPlaygroundOperation = 'replay' | 'simulation';

export interface HookPlaygroundCloseFailure {
  readonly error: unknown;
  readonly operation: HookPlaygroundOperation;
}

/** Reports every in-flight operation that failed to settle once shutdown cancelled it. */
export class HookPlaygroundCloseError extends Error {
  readonly code = 'AB8034';
  readonly failures: readonly HookPlaygroundCloseFailure[];

  constructor(failures: readonly HookPlaygroundCloseFailure[]) {
    super('Hook playground routes could not drain every in-flight operation.');
    this.name = 'HookPlaygroundCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

interface RunningOperation {
  readonly controller: AbortController;
  /**
   * Never rejects: it resolves to the failure that must survive shutdown, or to
   * undefined. Admission creates it unsettled so shutdown can already await an
   * operation whose service call has not returned its own promise yet.
   */
  readonly drained: Promise<{ readonly error: unknown } | undefined>;
  readonly operation: HookPlaygroundOperation;
}

export interface HookPlaygroundRouteService {
  list(options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]>;
  replay(
    replay: HookPlaygroundReplay,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult>;
  simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult>;
}

export interface HookPlaygroundRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench composes an epoch-bound hook playground service. */
  readonly service?: HookPlaygroundRouteService;
}

const diagnostic = (code: string, message: string, status: number): RequestDiagnostic => ({ code, message, status });

const requestError = (value: RequestDiagnostic): RequestDiagnostic & Error => Object.assign(
  new Error(value.message),
  value,
);

const isRequestDiagnostic = (value: unknown): value is RequestDiagnostic =>
  typeof value === 'object' && value !== null &&
  typeof (value as Partial<RequestDiagnostic>).code === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).message === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).status === 'number';

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

const singleHeader = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const unquoteHeaderValue = (value: string): string | undefined => {
  if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)) return value;
  if (!/^"(?:[^"\\\r\n]|\\[\t !-~])*"$/u.test(value)) return undefined;
  return value.slice(1, -1).replace(/\\([\t !-~])/gu, '$1');
};

const isJsonRequest = (request: IncomingMessage): boolean => {
  const contentType = singleHeader(request.headers['content-type']);
  if (contentType === undefined) return false;
  const parts = contentType.split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') return false;
  if (parts.length === 0) return true;
  if (parts.length !== 1) return false;
  const parameter = parts[0]!;
  const equals = parameter.indexOf('=');
  if (equals < 1 || parameter.slice(0, equals).trim().toLowerCase() !== 'charset') return false;
  return unquoteHeaderValue(parameter.slice(equals + 1).trim())?.toLowerCase() === 'utf-8';
};

const readBody = async (request: IncomingMessage): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
  let size = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > bodyLimit) {
      tooLarge = true;
      return;
    }
    if (!tooLarge) chunks.push(chunk);
  });
  request.once('end', () => {
    if (tooLarge) {
      rejectPromise(requestError(diagnostic('AB8010', 'Request body exceeds 64 KiB.', 413)));
      return;
    }
    resolvePromise(Buffer.concat(chunks).toString('utf8'));
  });
  request.once('error', rejectPromise);
});

const rawPathname = (requestTarget: string | undefined): string => requestTarget?.split(/[?#]/u, 1)[0] ?? '';

const decodedSegment = (segment: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw requestError(diagnostic('AB8030', 'Hook playground route path is not valid.', 400));
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) {
    throw requestError(diagnostic('AB8030', 'Hook playground route path is not valid.', 400));
  }
  return decoded;
};

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/hooks' && !pathname.startsWith('/api/hooks/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'hooks') {
    throw requestError(diagnostic('AB8030', 'Hook playground route path is not valid.', 400));
  }
  const segments = parts.slice(3).map(decodedSegment);
  if (segments.length === 0) return Object.freeze({ kind: 'hooks' });
  if (segments.length !== 1 || (segments[0] !== 'simulations' && segments[0] !== 'replays')) {
    throw requestError(diagnostic('AB8030', 'Hook playground route path is not valid.', 400));
  }
  return Object.freeze({ kind: segments[0] });
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnly = (value: JsonObject, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8032', 'Hook playground request has an invalid shape.', 400));
};

const jsonBody = async (request: IncomingMessage): Promise<JsonObject> => {
  if (!isJsonRequest(request)) {
    throw requestError(diagnostic('AB8009', 'Request body must use application/json.', 415));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(request));
  } catch (error) {
    if (isRequestDiagnostic(error)) throw error;
    throw requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400));
  }
  return isRecord(parsed) ? parsed : invalidShape();
};

const listQuery = (requestTarget: string | undefined): HookPlaygroundListOptions => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'epochId' && key !== 'target')) invalidShape();
  if (query.getAll('epochId').length !== 1 || query.getAll('target').length > 1) invalidShape();
  const epochId = query.get('epochId');
  const target = query.get('target');
  if (!nonemptyString(epochId)) return invalidShape();
  if (target === null) return Object.freeze({ epochId });
  if (!nonemptyString(target)) return invalidShape();
  return Object.freeze({ epochId, target });
};

/** Canonical hook input is authored JSON, so only plain JSON records may cross the boundary. */
const canonicalInput = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return invalidShape();
  return Object.freeze({ ...value });
};

const simulationInput = (value: unknown): HookPlaygroundInput => {
  if (!isRecord(value) || !hasOnly(value, ['fixture', 'inline'])) return invalidShape();
  const supplied = ['fixture', 'inline'].filter((field) => Object.hasOwn(value, field));
  if (supplied.length !== 1) return invalidShape();
  return supplied[0] === 'fixture'
    ? Object.freeze({ fixture: canonicalInput(value.fixture) })
    : Object.freeze({ inline: canonicalInput(value.inline) });
};

const simulationRequest = (value: JsonObject): Omit<HookPlaygroundSimulationOptions, 'signal'> => {
  if (!hasOnly(value, ['epochId', 'hook', 'input', 'target'])) return invalidShape();
  const { epochId, hook, target } = value;
  if (!nonemptyString(epochId) || !nonemptyString(hook) || !nonemptyString(target)) return invalidShape();
  if (!Object.hasOwn(value, 'input')) return invalidShape();
  return Object.freeze({ epochId, hook, input: simulationInput(value.input), target });
};

const replayRequest = (value: JsonObject): HookPlaygroundReplay => {
  if (!hasOnly(value, ['binding', 'input'])) return invalidShape();
  const binding = value.binding;
  if (!isRecord(binding) || !hasOnly(binding, ['epochId', 'hook', 'target'])) return invalidShape();
  const { epochId, hook, target } = binding;
  if (!nonemptyString(epochId) || !nonemptyString(hook) || !nonemptyString(target)) return invalidShape();
  if (!Object.hasOwn(value, 'input')) return invalidShape();
  return Object.freeze({
    binding: Object.freeze({ epochId, hook, target }),
    input: canonicalInput(value.input),
  });
};

/**
 * Shutdown cancels the operation itself, so the executor's cancellation is the
 * expected outcome, identified by the reason this route raised or by an error that
 * types itself as an abort. A message is not an identity: a wrapper process tree
 * that refused to settle, or a simulation clone that could not be removed, is a
 * real shutdown failure even when it reports the same text.
 */
const isExpectedCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === 'AbortError';
};

const simulationResponse = (
  result: HookPlaygroundSimulation | HookPlaygroundDiagnosticResult,
): unknown => 'diagnostics' in result ? { diagnostics: result.diagnostics } : { simulation: result };

/**
 * HTTP boundary for the epoch-bound hook playground. The browser selects an
 * epoch, hook, target, and canonical input; it never selects an artifact path,
 * wrapper command, or environment, all of which the service derives.
 */
export class HookPlaygroundRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #running = new Set<RunningOperation>();
  readonly #service: HookPlaygroundRouteService | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: HookPlaygroundRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  /**
   * Shutdown must not outlive the wrapper processes and simulation clones it
   * cancels, so every admitted operation is aborted once and then drained. All
   * callers share the single outcome of the first close, including a caller that
   * re-enters shutdown from an abort callback: the shared promise is published
   * before the first abort, so no re-entrant close can start a second drain.
   */
  close(): Promise<void> {
    const closing = this.#closePromise;
    if (closing !== undefined) return closing;
    const operations = [...this.#running];
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    this.#closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveClose = resolvePromise;
      rejectClose = rejectPromise;
    });
    this.#drain(operations).then(resolveClose, rejectClose);
    return this.#closePromise;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closePromise !== undefined) throw this.#unavailable(503);
    const service = this.#service;
    if (service === undefined) throw this.#unavailable(404);
    try {
      await this.#dispatch(parsed, request, response, service);
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      throw requestError(diagnostic('AB8033', 'Hook playground operation could not be completed.', 502));
    }
    return true;
  }

  async #dispatch(
    parsed: Route,
    request: IncomingMessage,
    response: ServerResponse,
    service: HookPlaygroundRouteService,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    if (parsed.kind === 'hooks') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { hooks: await service.list(listQuery(request.url)) });
    }
    if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    const body = await jsonBody(request);
    if (parsed.kind === 'simulations') {
      const options = simulationRequest(body);
      return responseJson(response, simulationResponse(await this.#cancellable(
        'simulation',
        response,
        (signal) => service.simulate({ ...options, signal }),
      )));
    }
    const replay = replayRequest(body);
    return responseJson(response, simulationResponse(await this.#cancellable(
      'replay',
      response,
      (signal) => service.replay(replay, { signal }),
    )));
  }

  async #drain(operations: readonly RunningOperation[]): Promise<void> {
    for (const operation of operations) operation.controller.abort();
    const settled = await Promise.all(operations.map((operation) => operation.drained));
    const failures = operations.flatMap((operation, index) => {
      const failure = settled[index];
      return failure === undefined ? [] : [Object.freeze({ error: failure.error, operation: operation.operation })];
    });
    if (failures.length > 0) throw new HookPlaygroundCloseError(failures);
  }

  /**
   * Abandoning a request must release the simulation clone and its wrapper
   * process. The response is the observable stream here: a fully read request
   * body has already emitted its own close. Shutdown drains the same operation,
   * so a request that only reaches here after close began is never admitted, and
   * one admitted before it is registered ahead of the service call — a service
   * that starts shutdown itself still finds its own operation admitted, aborted,
   * and awaited. Every settlement, including a synchronous throw, drains once.
   */
  async #cancellable<T>(
    operation: HookPlaygroundOperation,
    response: ServerResponse,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closePromise !== undefined) throw this.#unavailable(503);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    let drain!: (failure: { readonly error: unknown } | undefined) => void;
    const running: RunningOperation = Object.freeze({
      controller,
      drained: new Promise<{ readonly error: unknown } | undefined>((resolvePromise) => {
        drain = resolvePromise;
      }),
      operation,
    });
    this.#running.add(running);
    response.once('close', abort);
    try {
      if (response.destroyed || response.writableEnded) abort();
      const result = await action(controller.signal);
      drain(undefined);
      return result;
    } catch (error) {
      drain(isExpectedCancellation(error, controller.signal) ? undefined : Object.freeze({ error }));
      throw error;
    } finally {
      response.off('close', abort);
      this.#running.delete(running);
    }
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8031', 'Hook playground routes are not available.', status));
  }
}
