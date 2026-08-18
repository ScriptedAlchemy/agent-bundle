import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from './playground-contract.ts';
import { ScriptPlaygroundExecutionUnavailableError } from './script-playground-service.ts';
import {
  PlaygroundServiceError,
  type DraftEvalCase,
  type PlaygroundExport,
  type PlaygroundJsonObject,
  type PlaygroundJsonValue,
  type PlaygroundReplay,
  type PlaygroundReplayCursor,
  type PlaygroundServiceErrorCode,
  type PlaygroundSession,
  type PlaygroundSubscribeOptions,
  type PlaygroundSubscription,
  type PlaygroundTraceEvent,
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
  | 'draft-eval'
  | 'export'
  | 'replay'
  | 'stream';

type Route =
  | Readonly<{ readonly kind: 'runs' }>
  | Readonly<{ readonly id: string; readonly kind: 'cancel' }>
  | Readonly<{ readonly id: string; readonly kind: 'session' }>
  | Readonly<{ readonly id: string; readonly kind: SessionRouteKind }>;

type JsonObject = Record<string, unknown>;

export interface PlaygroundRouteService {
  cancel(runId: string): Promise<boolean>;
  export(sessionId: string): Promise<PlaygroundExport>;
  promoteToDraftEval(sessionId: string, rawEventRefs: readonly string[]): Promise<DraftEvalCase>;
  replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay>;
  run(input: PlaygroundOperationRequest, options?: { readonly signal?: AbortSignal }): Promise<PlaygroundRun>;
  session(sessionId: string): PlaygroundSession | undefined;
  subscribe(sessionId: string, options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription>;
}

export type { PlaygroundOperationRequest, PlaygroundRun } from './playground-contract.ts';

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
  'export',
  'replay',
  'stream',
]);

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/playground' && !pathname.startsWith('/api/playground/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'playground') return pathError();
  const segments = parts.slice(3).map(decodedSegment);
  if (segments[0] === 'runs') {
    if (segments.length === 1) return Object.freeze({ kind: 'runs' });
    if (segments.length === 3 && segments[2] === 'cancel') return Object.freeze({ id: segments[1]!, kind: 'cancel' });
    return undefined;
  }
  if (segments[0] !== 'sessions' || segments.length < 2) return undefined;
  const id = segments[1]!;
  if (segments.length === 2) return Object.freeze({ id, kind: 'session' });
  if (segments.length !== 3) return undefined;
  const kind = segments[2] as SessionRouteKind;
  return sessionRouteKinds.includes(kind) ? Object.freeze({ id, kind }) : undefined;
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
    parsed = parseJsonWithoutDuplicateKeys(await readBody(request));
  } catch (error) {
    if (isRequestDiagnostic(error)) throw error;
    throw requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400));
  }
  return isRecord(parsed) ? parsed : invalidShape();
};

const operationInput = (value: JsonObject): PlaygroundOperationRequest => {
  const operation = value.operation;
  const target = value.target;
  if (!nonemptyString(operation) || !nonemptyString(target)) return invalidShape();
  if (operation === 'skill.inspect') {
    if (!hasOnly(value, ['operation', 'skillId', 'target']) || !nonemptyString(value.skillId)) return invalidShape();
    return Object.freeze({ operation, skillId: value.skillId, target });
  }
  if (operation === 'hook.simulate') {
    if (!hasOnly(value, ['hook', 'input', 'operation', 'target']) || !nonemptyString(value.hook) || !Object.hasOwn(value, 'input')) return invalidShape();
    return Object.freeze({ hook: value.hook, input: jsonObject(value.input), operation, target });
  }
  if (operation === 'mcp.call-tool') {
    if (!hasOnly(value, ['arguments', 'operation', 'serverName', 'target', 'tool']) ||
      !nonemptyString(value.serverName) || !nonemptyString(value.tool) || !Object.hasOwn(value, 'arguments')) return invalidShape();
    return Object.freeze({ arguments: jsonObject(value.arguments), operation, serverName: value.serverName, target, tool: value.tool });
  }
  if (operation === 'script.run') {
    if (!hasOnly(value, ['operation', 'script', 'target']) || !nonemptyString(value.script)) return invalidShape();
    return Object.freeze({ operation, script: value.script, target });
  }
  return invalidShape();
};

const rawEventRefsInput = (value: JsonObject): readonly string[] => {
  if (!hasOnly(value, ['rawEventRefs']) || !Array.isArray(value.rawEventRefs)) return invalidShape();
  const refs = value.rawEventRefs;
  if (refs.some((ref) => !nonemptyString(ref)) || new Set(refs).size !== refs.length) return invalidShape();
  return Object.freeze([...refs]);
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
 * HTTP boundary for server-owned playground operations. The browser requests a
 * small typed operation and may read its resulting durable trace; it cannot
 * supply epoch identity, trace evidence, outcome, session ids, or execution
 * parameters such as paths, commands, working directories, or environments.
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
      if (error instanceof ScriptPlaygroundExecutionUnavailableError) {
        throw requestError(diagnostic('AB8086', 'OS-contained script execution is not configured.', 503));
      }
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
    if (parsed.kind === 'runs') {
      if (method !== 'POST') return this.#methodNotAllowed(response);
      return responseJson(response, { run: await service.run(operationInput(await jsonBody(request))) });
    }
    if (parsed.kind === 'cancel') {
      if (method !== 'POST') return this.#methodNotAllowed(response);
      if (!hasOnly(await jsonBody(request), [])) invalidShape();
      return responseJson(response, { cancelled: await service.cancel(parsed.id) });
    }
    if (parsed.kind === 'session') {
      if (method === 'GET') {
        noQuery(request.url);
        const session = service.session(parsed.id);
        if (session === undefined) throw requestError(serviceDiagnostics.PLAYGROUND_SESSION_NOT_FOUND);
        return responseJson(response, { session });
      }
      return this.#methodNotAllowed(response);
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
    const draftEvalCase = await service.promoteToDraftEval(parsed.id, rawEventRefsInput(body));
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
