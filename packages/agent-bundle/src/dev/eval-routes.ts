import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  EvalConfigError,
  EvalDefinitionError,
  EvalDiscoveryError,
  EvalFixtureError,
  EvalHarnessError,
  EvalRunStoreError,
} from '../eval/errors.ts';
import type { EvalComparison } from '../eval/compare.ts';
import type { EvalRunRecord } from '../eval/run-store.ts';
import {
  EvalServiceError,
  type EvalRunRequest,
  type EvalRunResult,
  type EvalServiceErrorCode,
  type EvalSuiteListing,
} from './eval-service.ts';

const bodyLimit = 64 * 1024;
const maximumTrials = 100;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type Route =
  | Readonly<{ readonly kind: 'comparisons' }>
  | Readonly<{ readonly kind: 'run'; readonly runId: string }>
  | Readonly<{ readonly kind: 'runs' }>
  | Readonly<{ readonly kind: 'suites' }>;

type JsonObject = Record<string, unknown>;

export interface EvalRouteService {
  compare(baseRunId: string, candidateRunId: string): Promise<EvalComparison>;
  list(): Promise<readonly EvalRunRecord[]>;
  read(runId: string): Promise<EvalRunResult>;
  run(request: EvalRunRequest): Promise<EvalRunResult>;
  suites(): Promise<EvalSuiteListing>;
}

export interface EvalRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench composes a project-bound eval service. */
  readonly service?: EvalRouteService;
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

/** Service messages name project paths, so each code keeps one fixed browser-facing sentence. */
const serviceDiagnostics: Readonly<Record<EvalServiceErrorCode, RequestDiagnostic>> = Object.freeze({
  EVAL_ARTIFACT_OUTSIDE_PROJECT: diagnostic('AB8084', 'The evaluated artifact must be inside the project.', 422),
  EVAL_HARNESS_UNSUPPORTED: diagnostic('AB8075', 'The requested eval harness is unknown or unsupported.', 422),
  EVAL_RUN_NOT_FOUND: diagnostic('AB8074', 'Eval run was not found.', 404),
  EVAL_SELECTION_EMPTY: diagnostic('AB8076', 'No discovered eval suite or case matched this selection.', 422),
  EVAL_SEMANTIC_GRADER_UNSUPPORTED: diagnostic('AB8083', 'Configured semantic grading requires the native Claude eval harness.', 422),
  EVAL_TARGET_MISSING: diagnostic('AB8077', 'The evaluated artifact has no target for a pinned eval host.', 422),
  EVAL_TRIALS_INVALID: diagnostic('AB8072', 'Eval request has an invalid shape.', 400),
});

const authoringDiagnostic = (error: unknown): RequestDiagnostic | undefined => {
  if (error instanceof EvalServiceError) return serviceDiagnostics[error.code];
  if (error instanceof EvalRunStoreError) {
    return error.code === 'EVAL_RUN_NOT_FOUND' || error.code === 'EVAL_RUN_ID_INVALID'
      ? serviceDiagnostics.EVAL_RUN_NOT_FOUND
      : diagnostic('AB8078', 'A recorded eval run could not be read.', 422);
  }
  if (error instanceof EvalConfigError) return diagnostic('AB8079', 'Project eval configuration is not valid.', 422);
  if (error instanceof EvalDefinitionError || error instanceof EvalDiscoveryError) {
    return diagnostic('AB8080', 'An authored eval suite is not valid.', 422);
  }
  if (error instanceof EvalFixtureError) return diagnostic('AB8081', 'An eval fixture could not be prepared.', 422);
  if (error instanceof EvalHarnessError) {
    return diagnostic('AB8082', 'The artifact under evaluation could not be prepared.', 422);
  }
  return undefined;
};

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
  const parameter = parts[0] ?? '';
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

const pathError = (): never => {
  throw requestError(diagnostic('AB8070', 'Eval route path is not valid.', 400));
};

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8072', 'Eval request has an invalid shape.', 400));
};

const decodedSegment = (segment: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return pathError();
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) {
    return pathError();
  }
  return decoded;
};

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/evals' && !pathname.startsWith('/api/evals/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'evals') return pathError();
  const segments = parts.slice(3).map(decodedSegment);
  if (segments.length === 1 && segments[0] === 'comparisons') return Object.freeze({ kind: 'comparisons' });
  if (segments.length === 1 && segments[0] === 'suites') return Object.freeze({ kind: 'suites' });
  if (segments.length === 1 && segments[0] === 'runs') return Object.freeze({ kind: 'runs' });
  if (segments.length !== 2 || segments[0] !== 'runs') return pathError();
  return Object.freeze({ kind: 'run', runId: segments[1] ?? pathError() });
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnly = (value: JsonObject, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');

const nameList = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0 || !value.every(nonemptyString)) return invalidShape();
  return Object.freeze([...value]);
};

const trials = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximumTrials) {
    return invalidShape();
  }
  return value;
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

/**
 * A browser selects authored suites, authored cases, and a trial count. Artifact
 * roots, harness names, run directories, and commands stay service-owned.
 */
const runRequest = (value: JsonObject): Omit<EvalRunRequest, 'artifact' | 'harness' | 'signal'> => {
  if (!hasOnly(value, ['caseIds', 'suites', 'trials'])) return invalidShape();
  return Object.freeze({
    ...(value.caseIds === undefined ? {} : { caseIds: nameList(value.caseIds) }),
    ...(value.suites === undefined ? {} : { suites: nameList(value.suites) }),
    ...(value.trials === undefined ? {} : { trials: trials(value.trials) }),
  });
};

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) invalidShape();
};

const comparisonQuery = (
  requestTarget: string | undefined,
): Readonly<{ readonly base: string; readonly candidate: string }> => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'base' && key !== 'candidate')) invalidShape();
  if (query.getAll('base').length !== 1 || query.getAll('candidate').length !== 1) invalidShape();
  const base = query.get('base');
  const candidate = query.get('candidate');
  if (!nonemptyString(base) || !nonemptyString(candidate)) return invalidShape();
  return Object.freeze({ base, candidate });
};

/**
 * HTTP boundary for evals. The browser names discovered suites and
 * cases; the service resolves the project, artifact, and run storage it uses.
 */
export class EvalRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #running = new Set<AbortController>();
  readonly #service: EvalRouteService | undefined;
  #closed = false;

  constructor(options: EvalRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#running) controller.abort();
    this.#running.clear();
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
      const mapped = authoringDiagnostic(error);
      if (mapped !== undefined) throw requestError(mapped);
      throw requestError(diagnostic('AB8073', 'Eval operation could not be completed.', 502));
    }
    return true;
  }

  async #dispatch(
    parsed: Route,
    request: IncomingMessage,
    response: ServerResponse,
    service: EvalRouteService,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    if (parsed.kind === 'runs' && method === 'POST') {
      const selection = runRequest(await jsonBody(request));
      return responseJson(response, {
        run: await this.#cancellable(response, (signal) => service.run({ ...selection, signal })),
      });
    }
    if (method !== 'GET') {
      return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    if (parsed.kind === 'comparisons') {
      const query = comparisonQuery(request.url);
      return responseJson(response, { comparison: await service.compare(query.base, query.candidate) });
    }
    noQuery(request.url);
    if (parsed.kind === 'suites') return responseJson(response, await service.suites());
    if (parsed.kind === 'runs') return responseJson(response, { runs: await service.list() });
    return responseJson(response, { run: await service.read(parsed.runId) });
  }

  /**
   * Abandoning a request must stop the run it started; the service finishes the
   * trials it already completed rather than tearing its record.
   */
  async #cancellable<T>(response: ServerResponse, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.#running.add(controller);
    response.once('close', abort);
    try {
      if (this.#closed || response.destroyed || response.writableEnded) abort();
      return await action(controller.signal);
    } finally {
      response.off('close', abort);
      this.#running.delete(controller);
    }
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8071', 'Eval routes are not available.', status));
  }
}
