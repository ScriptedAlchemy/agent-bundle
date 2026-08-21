import type { IncomingMessage, ServerResponse } from 'node:http';

import { CodedError } from '../core/errors.ts';
import { isRecord } from '../core/strict-json.ts';
import { isHookSimulationCancellation } from '../services/hook-service.ts';
import {
  decodedOpaqueSegment,
  diagnostic,
  hasOnly,
  isRequestDiagnostic,
  nonemptyString,
  rawPathname,
  readJsonBody,
  requestError,
  responseDiagnostic,
  responseJson as writeJsonResponse,
} from './http.ts';
import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundInput,
  HookPlaygroundListOptions,
  HookPlaygroundReplay,
  HookPlaygroundSimulation,
  HookPlaygroundSimulationOptions,
} from './hook-playground-service.ts';

type Route = Readonly<{ readonly kind: 'hooks' | 'simulations' | 'replays' }>;

type JsonObject = Record<string, unknown>;

export type HookPlaygroundOperation = 'replay' | 'simulation';

export interface HookPlaygroundCloseFailure {
  readonly error: unknown;
  readonly operation: HookPlaygroundOperation;
}

/** Reports every in-flight operation that failed to settle once shutdown cancelled it. */
export class HookPlaygroundCloseError extends CodedError<'AB8034'> {
  readonly failures: readonly HookPlaygroundCloseFailure[];

  constructor(failures: readonly HookPlaygroundCloseFailure[]) {
    super('HookPlaygroundCloseError', 'AB8034', 'Hook playground routes could not drain every in-flight operation.');
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

const responseJson = (response: ServerResponse, body: unknown): void =>
  writeJsonResponse(response, body, { destroyIfEnded: true });

const decodedSegment = (segment: string): string =>
  decodedOpaqueSegment(segment, { code: 'AB8030', message: 'Hook playground route path is not valid.' });

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

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8032', 'Hook playground request has an invalid shape.', 400));
};

const jsonBody = (request: IncomingMessage): Promise<JsonObject> => readJsonBody(request, { invalidShape });

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
 * expected outcome, identified by the reason this route raised or by the brand the
 * executor seam grants its own cancellation. Neither a name nor a message is an
 * identity: a wrapper process tree that refused to settle, or a simulation clone
 * that could not be removed, is a real shutdown failure even when it reports the
 * same surface.
 */
const isExpectedCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false;
  return error === signal.reason || isHookSimulationCancellation(error);
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
