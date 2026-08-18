import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  PlaygroundServiceError,
  type DraftEvalCase,
  type PlaygroundDurableOutcome,
  type PlaygroundEventInput,
  type PlaygroundExport,
  type PlaygroundJsonObject,
  type PlaygroundJsonValue,
  type PlaygroundReplay,
  type PlaygroundReplayCursor,
  type PlaygroundSelectedAssertion,
  type PlaygroundServiceErrorCode,
  type PlaygroundSession,
  type PlaygroundSessionInput,
  type PlaygroundSubscribeOptions,
  type PlaygroundSubscription,
  type PlaygroundTraceEvent,
  type PlaygroundTraceSource,
} from '../services/playground-service.ts';

/**
 * Trace events legitimately carry raw protocol frames, so this exceeds the MCP
 * route limit. It carries its own code because AB8010 is the wire contract for
 * the 64 KiB limit every other route group enforces.
 */
const bodyLimit = 1024 * 1024;
const maxValueDepth = 32;
const streamQueueByteLimit = 1024 * 1024;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type SessionRouteKind =
  | 'session'
  | 'draft-eval'
  | 'events'
  | 'export'
  | 'finalize'
  | 'reopen'
  | 'replay'
  | 'stream';

type Route =
  | Readonly<{ readonly kind: 'sessions' }>
  | Readonly<{ readonly id: string; readonly kind: SessionRouteKind }>;

type JsonObject = Record<string, unknown>;

export interface PlaygroundRouteService {
  append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent>;
  closeSession(sessionId: string): Promise<void>;
  export(sessionId: string): Promise<PlaygroundExport>;
  finalize(sessionId: string, outcome: PlaygroundDurableOutcome): Promise<PlaygroundSession>;
  openSession(input: PlaygroundSessionInput): Promise<PlaygroundSession>;
  promoteToDraftEval(sessionId: string, selectedAssertions: readonly PlaygroundSelectedAssertion[]): Promise<DraftEvalCase>;
  reopen(sessionId: string): Promise<PlaygroundSession>;
  replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay>;
  session(sessionId: string): PlaygroundSession | undefined;
  subscribe(sessionId: string, options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription>;
}

export interface PlaygroundRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench composes a durable playground service. */
  readonly service?: PlaygroundRouteService;
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

/**
 * Service failures stay actionable without republishing their messages, which
 * can name store paths. Each code keeps one fixed browser-facing sentence.
 */
const serviceDiagnostics: Readonly<Record<PlaygroundServiceErrorCode, RequestDiagnostic>> = Object.freeze({
  PLAYGROUND_CREDENTIAL_REJECTED: diagnostic('AB8053', 'Playground values may not carry provider credentials.', 400),
  PLAYGROUND_CURSOR_AHEAD: diagnostic('AB8048', 'Playground cursor is ahead of persisted history.', 409),
  PLAYGROUND_CURSOR_INVALID: diagnostic('AB8049', 'Playground cursor is not valid.', 400),
  PLAYGROUND_OUTCOME_REQUIRED: diagnostic('AB8052', 'A durable playground outcome is required first.', 400),
  PLAYGROUND_PROJECT_MISMATCH: diagnostic('AB8057', 'Playground session belongs to a different project.', 409),
  PLAYGROUND_ROOT_INVALID: diagnostic('AB8056', 'Playground storage root is not valid.', 500),
  PLAYGROUND_SERVICE_CLOSED: diagnostic('AB8054', 'Playground service is closed.', 503),
  PLAYGROUND_SESSION_CONFLICT: diagnostic('AB8045', 'Playground session already exists.', 409),
  PLAYGROUND_SESSION_FINALIZED: diagnostic('AB8046', 'Playground session is already finalized.', 409),
  PLAYGROUND_SESSION_ID_INVALID: diagnostic('AB8051', 'Playground session id is not valid.', 400),
  PLAYGROUND_SESSION_NOT_FOUND: diagnostic('AB8044', 'Playground session was not found.', 404),
  PLAYGROUND_SESSION_OWNED: diagnostic('AB8047', 'Playground session is owned by another writer.', 409),
  PLAYGROUND_STORE_CORRUPT: diagnostic('AB8055', 'Playground store is corrupt.', 500),
  PLAYGROUND_VALUE_INVALID: diagnostic('AB8050', 'Playground request has an invalid value.', 400),
});

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
      rejectPromise(requestError(diagnostic('AB8085', 'Request body exceeds 1 MiB.', 413)));
      return;
    }
    resolvePromise(Buffer.concat(chunks).toString('utf8'));
  });
  request.once('error', rejectPromise);
});

const rawPathname = (requestTarget: string | undefined): string => requestTarget?.split(/[?#]/u, 1)[0] ?? '';

const pathError = (): never => {
  throw requestError(diagnostic('AB8040', 'Playground route path is not valid.', 400));
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

const sessionRouteKinds: readonly SessionRouteKind[] = Object.freeze([
  'draft-eval',
  'events',
  'export',
  'finalize',
  'reopen',
  'replay',
  'stream',
]);

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/playground' && !pathname.startsWith('/api/playground/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'playground') return pathError();
  const segments = parts.slice(3).map(decodedSegment);
  if (segments[0] !== 'sessions') return pathError();
  if (segments.length === 1) return Object.freeze({ kind: 'sessions' });
  const id = segments[1]!;
  if (segments.length === 2) return Object.freeze({ id, kind: 'session' });
  if (segments.length !== 3) return pathError();
  const kind = segments[2] as SessionRouteKind;
  if (!sessionRouteKinds.includes(kind)) return pathError();
  return Object.freeze({ id, kind });
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnly = (value: JsonObject, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8042', 'Playground request has an invalid shape.', 400));
};

const jsonValue = (value: unknown, depth = 0): PlaygroundJsonValue => {
  if (depth > maxValueDepth) return invalidShape();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalidShape();
  if (Array.isArray(value)) return Object.freeze(value.map((item) => jsonValue(item, depth + 1)));
  if (!isRecord(value)) return invalidShape();
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonValue(item, depth + 1)]),
  )) as PlaygroundJsonObject;
};

const jsonObject = (value: unknown, depth = 0): PlaygroundJsonObject => {
  if (!isRecord(value)) return invalidShape();
  return jsonValue(value, depth) as PlaygroundJsonObject;
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

const digestIdentity = (value: unknown): Readonly<{ readonly digest: string; readonly id: string }> => {
  if (!isRecord(value) || !hasOnly(value, ['digest', 'id'])) return invalidShape();
  const { digest, id } = value;
  if (!nonemptyString(digest) || !nonemptyString(id)) return invalidShape();
  return Object.freeze({ digest, id });
};

const sessionInput = (value: JsonObject): PlaygroundSessionInput => {
  if (!hasOnly(value, ['epoch', 'fixture', 'invocation', 'sessionId', 'target', 'task'])) return invalidShape();
  const { invocation, target, task } = value;
  if (!isRecord(invocation) || !hasOnly(invocation, ['intent', 'kind']) || !nonemptyString(invocation.kind)) {
    return invalidShape();
  }
  if (!isRecord(target) || !hasOnly(target, ['digest', 'name']) || !nonemptyString(target.name)) return invalidShape();
  if (target.digest !== undefined && !nonemptyString(target.digest)) return invalidShape();
  if (!isRecord(task) || !hasOnly(task, ['id', 'text']) || !nonemptyString(task.id) || !nonemptyString(task.text)) {
    return invalidShape();
  }
  if (value.sessionId !== undefined && !nonemptyString(value.sessionId)) return invalidShape();
  return Object.freeze({
    epoch: digestIdentity(value.epoch),
    fixture: digestIdentity(value.fixture),
    invocation: Object.freeze({ intent: jsonObject(invocation.intent), kind: invocation.kind }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
    target: Object.freeze({
      ...(target.digest === undefined ? {} : { digest: target.digest }),
      name: target.name,
    }),
    task: Object.freeze({ id: task.id, text: task.text }),
  });
};

const traceSources: readonly PlaygroundTraceSource[] = Object.freeze([
  'build',
  'diagnostics',
  'hook',
  'host-preflight',
  'mcp',
  'project',
  'response',
  'script',
  'skill-evidence',
  'workspace-change',
]);

const eventInput = (value: JsonObject): PlaygroundEventInput => {
  if (!hasOnly(value, ['kind', 'raw', 'source', 'summary'])) return invalidShape();
  const { kind, source, summary } = value;
  if (!nonemptyString(kind) || !nonemptyString(summary)) return invalidShape();
  if (typeof source !== 'string' || !traceSources.includes(source as PlaygroundTraceSource)) return invalidShape();
  if (!Object.hasOwn(value, 'raw')) return invalidShape();
  return Object.freeze({ kind, raw: jsonValue(value.raw), source: source as PlaygroundTraceSource, summary });
};

const outcomeInput = (value: JsonObject): PlaygroundDurableOutcome => {
  if (!hasOnly(value, ['response', 'status', 'workspace'])) return invalidShape();
  const { response, status, workspace } = value;
  if (!nonemptyString(status)) return invalidShape();
  if (response !== undefined && typeof response !== 'string') return invalidShape();
  return Object.freeze({
    ...(response === undefined ? {} : { response }),
    status,
    ...(workspace === undefined ? {} : { workspace: jsonObject(workspace) }),
  });
};

const assertionsInput = (value: JsonObject): readonly PlaygroundSelectedAssertion[] => {
  if (!hasOnly(value, ['assertions'])) return invalidShape();
  const assertions = value.assertions;
  if (!Array.isArray(assertions)) return invalidShape();
  return Object.freeze(assertions.map((entry: unknown) => {
    if (!isRecord(entry) || !hasOnly(entry, ['evidence', 'expectation', 'id', 'kind'])) return invalidShape();
    if (!nonemptyString(entry.id) || !nonemptyString(entry.kind)) return invalidShape();
    if (!Object.hasOwn(entry, 'evidence') || !Object.hasOwn(entry, 'expectation')) return invalidShape();
    return Object.freeze({
      evidence: jsonValue(entry.evidence),
      expectation: jsonValue(entry.expectation),
      id: entry.id,
      kind: entry.kind,
    });
  }));
};

const queryCursor = (requestTarget: string | undefined): number => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'after') || query.getAll('after').length > 1) {
    throw requestError(diagnostic('AB8049', 'Playground cursor is not valid.', 400));
  }
  const value = query.get('after');
  if (value === null) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw requestError(diagnostic('AB8049', 'Playground cursor is not valid.', 400));
  }
  const after = Number(value);
  if (!Number.isSafeInteger(after)) {
    throw requestError(diagnostic('AB8049', 'Playground cursor is not valid.', 400));
  }
  return after;
};

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) invalidShape();
};

/**
 * HTTP boundary for the durable playground trace store. The browser supplies
 * only task, fixture, epoch, and invocation identity plus JSON trace payloads;
 * it never selects a storage root, project identity, or executable.
 */
export class PlaygroundRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #service: PlaygroundRouteService | undefined;
  readonly #streamClosers = new Set<() => void>();
  #closed = false;

  constructor(options: PlaygroundRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const close of this.#streamClosers) close();
    this.#streamClosers.clear();
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
      if (error instanceof PlaygroundServiceError) throw requestError(serviceDiagnostics[error.code]);
      throw requestError(diagnostic('AB8043', 'Playground operation could not be completed.', 502));
    }
    return true;
  }

  async #dispatch(
    parsed: Route,
    request: IncomingMessage,
    response: ServerResponse,
    service: PlaygroundRouteService,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    if (parsed.kind === 'sessions') {
      if (method !== 'POST') return this.#methodNotAllowed(response);
      return responseJson(response, { session: await service.openSession(sessionInput(await jsonBody(request))) });
    }
    if (parsed.kind === 'session') {
      if (method === 'GET') {
        noQuery(request.url);
        const session = service.session(parsed.id);
        if (session === undefined) throw requestError(serviceDiagnostics.PLAYGROUND_SESSION_NOT_FOUND);
        return responseJson(response, { session });
      }
      if (method !== 'DELETE') return this.#methodNotAllowed(response);
      await service.closeSession(parsed.id);
      return responseJson(response, { closed: true });
    }
    if (parsed.kind === 'replay') {
      if (method !== 'GET') return this.#methodNotAllowed(response);
      const replay = await service.replay(parsed.id, { afterSequence: queryCursor(request.url) });
      return responseJson(response, { replay });
    }
    if (parsed.kind === 'export') {
      if (method !== 'GET') return this.#methodNotAllowed(response);
      noQuery(request.url);
      return responseJson(response, { export: await service.export(parsed.id) });
    }
    if (parsed.kind === 'stream') {
      if (method !== 'GET') return this.#methodNotAllowed(response);
      return this.#stream(service, parsed.id, queryCursor(request.url), request, response);
    }
    if (method !== 'POST') return this.#methodNotAllowed(response);
    const body = await jsonBody(request);
    if (parsed.kind === 'events') {
      return responseJson(response, { event: await service.append(parsed.id, eventInput(body)) });
    }
    if (parsed.kind === 'finalize') {
      return responseJson(response, { session: await service.finalize(parsed.id, outcomeInput(body)) });
    }
    if (parsed.kind === 'reopen') {
      if (!hasOnly(body, [])) invalidShape();
      return responseJson(response, { session: await service.reopen(parsed.id) });
    }
    const draftEvalCase = await service.promoteToDraftEval(parsed.id, assertionsInput(body));
    return responseJson(response, { draftEvalCase });
  }

  #methodNotAllowed(response: ServerResponse): void {
    responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8041', 'Playground routes are not available.', status));
  }

  async #stream(
    service: PlaygroundRouteService,
    sessionId: string,
    afterSequence: number,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let closed = false;
    let pendingBytes = 0;
    let started = false;
    let backlogBytes = 0;
    const backlog: string[] = [];
    const stream = { subscription: undefined as PlaygroundSubscription | undefined };
    let cleanup = (): void => undefined;
    const finishStream = (): void => {
      cleanup();
      if (!response.writableEnded && !response.destroyed) response.end();
    };
    const write = async (frame: string): Promise<void> => {
      const bytes = Buffer.byteLength(frame);
      if (pendingBytes + bytes > streamQueueByteLimit) {
        cleanup();
        response.destroy();
        return;
      }
      if (response.write(frame)) return;
      pendingBytes += bytes;
      await new Promise<void>((resolvePromise) => {
        // Exactly one of these fires; leaving the other registered would retain
        // this closure for the life of the connection, one per backpressured frame.
        const settle = (): void => {
          response.off('drain', settle);
          response.off('close', settle);
          pendingBytes -= bytes;
          resolvePromise();
        };
        response.once('drain', settle);
        response.once('close', settle);
      });
    };
    /**
     * The service delivers any backlog from inside subscribe(), before the cursor
     * has been accepted and headers committed. Those frames are held rather than
     * written, because an implicit header write here would lose the diagnostic.
     */
    const deliver = async (event: PlaygroundTraceEvent): Promise<void> => {
      if (closed || response.writableEnded || response.destroyed) return;
      const frame = `${JSON.stringify(event)}\n`;
      if (!started) {
        backlogBytes += Buffer.byteLength(frame);
        if (backlogBytes > streamQueueByteLimit) {
          cleanup();
          response.destroy();
          return;
        }
        backlog.push(frame);
        return;
      }
      await write(frame);
    };
    cleanup = (): void => {
      if (closed) return;
      closed = true;
      this.#streamClosers.delete(finishStream);
      void stream.subscription?.close().catch(() => undefined);
    };

    // Validate the cursor before committing headers so an ahead cursor stays a JSON diagnostic.
    const subscription = await service.subscribe(sessionId, { afterSequence, onEvent: deliver });
    stream.subscription = subscription;
    if (this.#closed || request.destroyed || response.destroyed) {
      cleanup();
      if (!response.writableEnded && !response.destroyed) response.end();
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'content-type': 'application/x-ndjson; charset=utf-8',
    });
    response.flushHeaders();
    this.#streamClosers.add(finishStream);
    request.once('close', cleanup);
    response.once('close', cleanup);
    started = true;
    for (const frame of backlog.splice(0)) {
      if (closed || response.writableEnded || response.destroyed) return;
      await write(frame);
    }
  }
}
