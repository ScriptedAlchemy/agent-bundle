import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { hasOnlyOwnKeys, parseJsonWithoutDuplicateKeys } from '../../core/strict-json.ts';
import {
  EvalConfigError,
  EvalDefinitionError,
  EvalDiscoveryError,
  EvalFixtureError,
  EvalHarnessError,
  EvalRunStoreError,
} from '../../eval/errors.ts';
import type { EvalComparison } from '../../eval/compare.ts';
import type { EvalRunRecord } from '../../eval/run-store.ts';
import {
  type EvalArtifactReader,
  EvalServiceError,
  type EvalRunAdmission,
  type EvalRunEventsReplay,
  type EvalRunRequest,
  type EvalRunResult,
  type EvalServiceErrorCode,
  type EvalSuiteListing,
} from './eval-service.ts';

const bodyLimit = 64 * 1024;
const maximumTrials = 100;
const streamByteLimit = 256 * 1024;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type Route =
  | Readonly<{ readonly artifactRef: string; readonly kind: 'artifact'; readonly runId: string }>
  | Readonly<{ readonly kind: 'cancel'; readonly runId: string }>
  | Readonly<{ readonly kind: 'comparisons' }>
  | Readonly<{ readonly kind: 'events'; readonly runId: string }>
  | Readonly<{ readonly kind: 'run'; readonly runId: string }>
  | Readonly<{ readonly kind: 'runs' }>
  | Readonly<{ readonly kind: 'stream'; readonly runId: string }>
  | Readonly<{ readonly kind: 'suites' }>;

type JsonObject = Record<string, unknown>;

export interface EvalRouteService {
  compare(baseRunId: string, candidateRunId: string): Promise<EvalComparison>;
  events(runId: string, afterSequence: number): Promise<EvalRunEventsReplay>;
  list(): Promise<readonly EvalRunRecord[]>;
  openArtifact(runId: string, artifactRef: string): Promise<EvalArtifactReader>;
  read(runId: string): Promise<EvalRunResult>;
  start(request: EvalRunRequest): Promise<EvalRunAdmission>;
  cancel(runId: string): Promise<boolean>;
  subscribeEvents(runId: string, afterSequence: number): Promise<{
    readonly replay: EvalRunEventsReplay;
    activate(listener: (event: EvalRunEventsReplay['events'][number]) => void): void;
    close(): void;
  }>;
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
  EVAL_ARTIFACT_NOT_FOUND: diagnostic('AB8085', 'Recorded raw evidence was not found.', 404),
  EVAL_ARTIFACT_UNAVAILABLE: diagnostic('AB8086', 'Recorded raw evidence is not available.', 422),
  EVAL_EVENTS_CURSOR_INVALID: diagnostic('AB8087', 'Eval event cursor is not valid.', 400),
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

const responseJson = (response: ServerResponse, body: unknown, status = 200): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const terminalEvent = (event: EvalRunEventsReplay['events'][number]): boolean =>
  event.kind === 'run.cancelled' || event.kind === 'run.completed' || event.kind === 'run.failed';

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

const opaqueArtifactRef = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,8192}$/u.test(value)) return pathError();
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) return pathError();
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
  if (segments.length === 3 && segments[0] === 'runs' && segments[2] === 'events') {
    return Object.freeze({ kind: 'events', runId: segments[1] ?? pathError() });
  }
  if (segments.length === 3 && segments[0] === 'runs' && segments[2] === 'stream') {
    return Object.freeze({ kind: 'stream', runId: segments[1] ?? pathError() });
  }
  if (segments.length === 3 && segments[0] === 'runs' && segments[2] === 'cancel') {
    return Object.freeze({ kind: 'cancel', runId: segments[1] ?? pathError() });
  }
  if (segments.length === 4 && segments[0] === 'runs' && segments[2] === 'artifacts') {
    return Object.freeze({
      artifactRef: opaqueArtifactRef(segments[3] ?? pathError()),
      kind: 'artifact',
      runId: segments[1] ?? pathError(),
    });
  }
  if (segments.length !== 2 || segments[0] !== 'runs') return pathError();
  return Object.freeze({ kind: 'run', runId: segments[1] ?? pathError() });
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnly: (value: JsonObject, fields: readonly string[]) => boolean = hasOnlyOwnKeys;

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
    parsed = parseJsonWithoutDuplicateKeys(await readBody(request));
  } catch (error) {
    if (isRequestDiagnostic(error)) throw error;
    throw requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400));
  }
  return isRecord(parsed) ? parsed : invalidShape();
};

/**
 * A browser selects authored suites, authored cases, and a trial count. Artifact
 * roots, run directories, models, and commands stay service-owned.
 */
const runRequest = (value: JsonObject): Omit<EvalRunRequest, 'artifact' | 'signal'> => {
  if (!hasOnly(value, ['caseIds', 'harness', 'suites', 'trials'])) return invalidShape();
  if (value.harness !== undefined && value.harness !== 'deterministic' && value.harness !== 'claude' && value.harness !== 'codex') {
    return invalidShape();
  }
  return Object.freeze({
    ...(value.caseIds === undefined ? {} : { caseIds: nameList(value.caseIds) }),
    ...(value.harness === undefined ? {} : { harness: value.harness }),
    ...(value.suites === undefined ? {} : { suites: nameList(value.suites) }),
    ...(value.trials === undefined ? {} : { trials: trials(value.trials) }),
  });
};

const cancelRequest = async (request: IncomingMessage): Promise<void> => {
  if (!hasOnly(await jsonBody(request), [])) invalidShape();
};

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) invalidShape();
};

const eventCursor = (requestTarget: string | undefined): number => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'after') || query.getAll('after').length > 1) invalidShape();
  const value = query.get('after');
  if (value === null) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(value)) invalidShape();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidShape();
  return parsed;
};

interface ByteRange {
  readonly end: number;
  readonly start: number;
}

const byteRange = (value: string | readonly string[] | undefined, size: number): ByteRange | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || size < 1) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (match === null || match[1] === '' && match[2] === '') return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  const start = startText === '' ? undefined : Number(startText);
  const end = endText === '' ? undefined : Number(endText);
  if (
    start !== undefined && !Number.isSafeInteger(start) ||
    end !== undefined && !Number.isSafeInteger(end)
  ) return null;
  if (start === undefined) {
    if (end === undefined || end < 1) return null;
    return Object.freeze({ end: size - 1, start: Math.max(0, size - end) });
  }
  if (start >= size || end !== undefined && end < start) return null;
  return Object.freeze({ end: end === undefined ? size - 1 : Math.min(end, size - 1), start });
};

const contentType = (filename: string): string => {
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filename.endsWith('.jsonl')) return 'application/x-ndjson; charset=utf-8';
  if (/\.(?:log|md|text|txt)$/iu.test(filename)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
};

const artifactHeaders = (artifact: EvalArtifactReader, range: ByteRange | undefined): Record<string, string> => {
  const length = range === undefined ? artifact.size : range.end - range.start + 1;
  return {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${artifact.filename}"`,
    'content-length': String(length),
    'content-type': contentType(artifact.filename),
    ...(range === undefined ? {} : { 'content-range': `bytes ${range.start}-${range.end}/${artifact.size}` }),
    etag: `"${artifact.digest}"`,
    'x-content-type-options': 'nosniff',
  };
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
  readonly #admissions = new Set<Promise<void>>();
  readonly #closeFailures = new Set<unknown>();
  readonly #closeReaders = new Set<() => Promise<void>>();
  readonly #readerCloses = new Set<Promise<void>>();
  readonly #service: EvalRouteService | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: EvalRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#admissions]);
      const results = await Promise.allSettled([...this.#closeReaders].map(async (close) => close()));
      await Promise.allSettled([...this.#readerCloses]);
      this.#closeReaders.clear();
      const failures = [
        ...results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason),
        ...this.#closeFailures,
      ];
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Eval route readers could not close.');
      }
    });
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
      const finishAdmission = this.#beginAdmission();
      try {
        const selection = runRequest(await jsonBody(request));
        if (this.#closePromise !== undefined) throw this.#unavailable(503);
        const admission = await service.start(selection);
        return responseJson(response, { run: admission.run }, 202);
      } finally {
        finishAdmission();
      }
    }
    if (parsed.kind === 'cancel' && method === 'POST') {
      const finishAdmission = this.#beginAdmission();
      try {
        noQuery(request.url);
        await cancelRequest(request);
        if (this.#closePromise !== undefined) throw this.#unavailable(503);
        const cancelled = await service.cancel(parsed.runId);
        return responseJson(response, { cancelled, runId: parsed.runId }, 202);
      } finally {
        finishAdmission();
      }
    }
    if (method !== 'GET' && !(parsed.kind === 'artifact' && method === 'HEAD')) {
      return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    if (parsed.kind === 'comparisons') {
      const query = comparisonQuery(request.url);
      return responseJson(response, { comparison: await service.compare(query.base, query.candidate) });
    }
    if (parsed.kind === 'events') {
      return responseJson(response, { replay: await service.events(parsed.runId, eventCursor(request.url)) });
    }
    if (parsed.kind === 'stream') {
      return this.#stream(response, service, parsed.runId, eventCursor(request.url));
    }
    if (parsed.kind === 'artifact') {
      return this.#artifact(request, response, service, parsed);
    }
    noQuery(request.url);
    if (parsed.kind === 'suites') return responseJson(response, await service.suites());
    if (parsed.kind === 'runs') return responseJson(response, { runs: await service.list() });
    return responseJson(response, { run: await service.read(parsed.runId) });
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8071', 'Eval routes are not available.', status));
  }

  #beginAdmission(): () => void {
    let settle!: () => void;
    const admission = new Promise<void>((resolvePromise) => { settle = resolvePromise; });
    this.#admissions.add(admission);
    return (): void => {
      this.#admissions.delete(admission);
      settle();
    };
  }

  #trackReaderClose(close: Promise<void>): Promise<void> {
    this.#readerCloses.add(close);
    void close.then(
      () => { this.#readerCloses.delete(close); },
      (error: unknown) => {
        this.#readerCloses.delete(close);
        this.#closeFailures.add(error);
      },
    );
    return close;
  }

  async #stream(
    response: ServerResponse,
    service: EvalRouteService,
    runId: string,
    afterSequence: number,
  ): Promise<void> {
    const finishAdmission = this.#beginAdmission();
    let responseClosed = response.destroyed || response.writableEnded;
    const markResponseClosed = (): void => { responseClosed = true; };
    response.once('close', markResponseClosed);
    try {
      const subscription = await service.subscribeEvents(runId, afterSequence);
      let buffered = 0;
      let blocked = false;
      let blockedBytes = 0;
      let closed = false;
      let closePromise: Promise<void> | undefined;
      let flushing = false;
      let terminalQueued = false;
      const frames: Array<Readonly<{ readonly frame: string; readonly size: number }>> = [];
      const onDrain = (): void => {
        if (closed || !blocked) return;
        blocked = false;
        buffered -= blockedBytes;
        blockedBytes = 0;
        flush();
      };
      const close = (abortResponse = false): Promise<void> => {
        if (closePromise !== undefined) return closePromise;
        closed = true;
        frames.length = 0;
        buffered = 0;
        blockedBytes = 0;
        this.#closeReaders.delete(closeFromShutdown);
        response.off('close', closeFromPeer);
        response.off('close', markResponseClosed);
        response.off('drain', onDrain);
        if (abortResponse && !response.destroyed && !response.writableEnded) response.destroy();
        closePromise = this.#trackReaderClose(Promise.resolve().then(() => subscription.close()));
        return closePromise;
      };
      const closeFromPeer = (): void => { void close().catch(() => undefined); };
      const closeFromShutdown = (): Promise<void> => close(true);
      if (responseClosed || this.#closePromise !== undefined) {
        await close();
        throw this.#unavailable(503);
      }
      const flush = (): void => {
        if (flushing || blocked || closed || response.destroyed || response.writableEnded) return;
        flushing = true;
        try {
          while (!blocked && frames.length > 0) {
            const next = frames.shift()!;
            if (response.write(next.frame)) {
              buffered -= next.size;
              continue;
            }
            blocked = true;
            blockedBytes = next.size;
            response.once('drain', onDrain);
          }
          if (!blocked && terminalQueued && frames.length === 0) {
            response.end();
            void close().catch(() => undefined);
          }
        } finally {
          flushing = false;
        }
      };
      const enqueue = (event: EvalRunEventsReplay['events'][number]): void => {
        if (closed || terminalQueued) return;
        const frame = `${JSON.stringify(event)}\n`;
        const size = Buffer.byteLength(frame, 'utf8');
        if (buffered + size > streamByteLimit) {
          void close(true).catch(() => undefined);
          return;
        }
        frames.push(Object.freeze({ frame, size }));
        buffered += size;
        terminalQueued = terminalEvent(event);
        flush();
      };
      const replayBytes = subscription.replay.events.reduce((total, event) =>
        total + Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8'), 0);
      if (replayBytes > streamByteLimit) {
        await close();
        responseDiagnostic(response, diagnostic('AB8088', 'Eval event replay exceeds the stream limit.', 413));
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
      this.#closeReaders.add(closeFromShutdown);
      response.once('close', closeFromPeer);
      response.off('close', markResponseClosed);
      for (const event of subscription.replay.events) enqueue(event);
      if (!closed && !terminalQueued) subscription.activate(enqueue);
      flush();
    } finally {
      response.off('close', markResponseClosed);
      finishAdmission();
    }
  }

  async #artifact(
    request: IncomingMessage,
    response: ServerResponse,
    service: EvalRouteService,
    route: Extract<Route, { readonly kind: 'artifact' }>,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return;
    }
    const finishAdmission = this.#beginAdmission();
    let responseClosed = response.destroyed || response.writableEnded;
    const markResponseClosed = (): void => { responseClosed = true; };
    response.once('close', markResponseClosed);
    try {
      const artifact = await service.openArtifact(route.runId, route.artifactRef);
      if (responseClosed || this.#closePromise !== undefined) {
        await artifact.close();
        throw this.#unavailable(503);
      }
      const range = byteRange(request.headers.range, artifact.size);
      if (range === null) {
        try {
          response.writeHead(416, {
            'accept-ranges': 'bytes',
            'cache-control': 'no-store',
            'content-range': `bytes */${artifact.size}`,
            'x-content-type-options': 'nosniff',
          });
          response.end();
        } finally {
          await artifact.close();
        }
        return;
      }
      response.writeHead(range === undefined ? 200 : 206, artifactHeaders(artifact, range));
      if (method === 'HEAD') {
        try { response.end(); }
        finally { await artifact.close(); }
        return;
      }
      response.flushHeaders();
      let closePromise: Promise<void> | undefined;
      let stream: Readable | undefined;
      const close = (abortResponse = false): Promise<void> => {
        if (closePromise !== undefined) return closePromise;
        this.#closeReaders.delete(closeFromShutdown);
        response.off('close', closeFromPeer);
        response.off('close', markResponseClosed);
        stream?.destroy();
        if (abortResponse && !response.destroyed && !response.writableEnded) response.destroy();
        closePromise = this.#trackReaderClose(artifact.close());
        return closePromise;
      };
      const closeFromPeer = (): void => { void close().catch(() => undefined); };
      const closeFromShutdown = (): Promise<void> => close(true);
      try {
        stream = range === undefined ? artifact.read() : artifact.read(range.start, range.end);
        this.#closeReaders.add(closeFromShutdown);
        response.once('close', closeFromPeer);
        stream.once('error', () => {
          void close(true).catch(() => undefined);
          response.destroy();
        });
        stream.once('end', closeFromPeer);
        stream.pipe(response);
      } catch (error) {
        await close();
        throw error;
      }
    } finally {
      response.off('close', markResponseClosed);
      finishAdmission();
    }
  }
}
