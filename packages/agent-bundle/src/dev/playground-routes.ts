import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { isRecord } from '../core/strict-json.ts';
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
  type RequestDiagnostic,
} from './http.ts';
import type { NativePlaygroundCatalog } from './native-playground-service.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from './playground-contract.ts';
import { encodedNdjsonFrame, writeKeepAliveStreamHead } from './route-streams.ts';

/**
 * Trace events legitimately carry raw protocol frames, so this exceeds the MCP
 * route limit. It carries its own code because AB8010 is the wire contract for
 * the 64 KiB limit every other route group enforces.
 */
const bodyLimit = 1024 * 1024;
const maxValueDepth = 32;
const streamQueueByteLimit = 1024 * 1024;

type SessionRouteKind =
  | 'draft-eval'
  | 'export'
  | 'replay'
  | 'stream';

type Route =
  | Readonly<{ readonly kind: 'catalog' }>
  | Readonly<{ readonly kind: 'runs' }>
  | Readonly<{ readonly id: string; readonly kind: 'cancel' }>
  | Readonly<{ readonly id: string; readonly kind: 'session' }>
  | Readonly<{ readonly id: string; readonly kind: SessionRouteKind }>;

type JsonObject = Record<string, unknown>;

export interface PlaygroundRouteService {
  cancel(runId: string): Promise<boolean>;
  catalog?(options?: { readonly epochId?: string }): Promise<NativePlaygroundCatalog>;
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

const responseJson = (response: ServerResponse, body: unknown): void =>
  writeJsonResponse(response, body, { destroyIfEnded: true });

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

const pathError = (): never => {
  throw requestError(diagnostic('AB8040', 'Playground route path is not valid.', 400));
};

const decodedSegment = (segment: string): string =>
  decodedOpaqueSegment(segment, { code: 'AB8040', message: 'Playground route path is not valid.' });

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
  if (segments[0] === 'catalog' && segments.length === 1) return Object.freeze({ kind: 'catalog' });
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

const jsonBody = (request: IncomingMessage): Promise<JsonObject> => readJsonBody(request, {
  invalidShape,
  read: { code: 'AB8085', limit: bodyLimit, message: 'Request body exceeds 1 MiB.' },
});

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
  if (operation === 'native.prompt') {
    const epochId = value.epochId;
    if (
      !hasOnly(value, ['caseId', 'epochId', 'fixtureId', 'host', 'modelPinId', 'operation', 'prompt', 'target']) ||
      !nonemptyString(value.caseId) ||
      !nonemptyString(value.fixtureId) ||
      !nonemptyString(value.modelPinId) ||
      !nonemptyString(value.prompt) ||
      (value.host !== 'claude' && value.host !== 'codex') ||
      (Object.hasOwn(value, 'epochId') && !nonemptyString(epochId))
    ) return invalidShape();
    const resolvedEpochId = typeof epochId === 'string' ? epochId : undefined;
    return Object.freeze({
      caseId: value.caseId,
      ...(resolvedEpochId === undefined ? {} : { epochId: resolvedEpochId }),
      fixtureId: value.fixtureId,
      host: value.host,
      modelPinId: value.modelPinId,
      operation,
      prompt: value.prompt,
      target,
    });
  }
  if (operation === 'script.run') {
    if (!hasOnly(value, ['operation', 'scriptId', 'target']) || !nonemptyString(value.scriptId)) return invalidShape();
    return Object.freeze({ operation, scriptId: value.scriptId, target });
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

const catalogEpoch = (requestTarget: string | undefined): string | undefined => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'epochId') || query.getAll('epochId').length > 1) invalidShape();
  const epochId = query.get('epochId');
  if (epochId !== null && !nonemptyString(epochId)) invalidShape();
  return epochId ?? undefined;
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
    if (parsed.kind === 'catalog') {
      if (method !== 'GET') return this.#methodNotAllowed(response);
      const catalog = service.catalog;
      if (catalog === undefined) throw this.#unavailable(404);
      const epochId = catalogEpoch(request.url);
      return responseJson(response, { catalog: await catalog.call(service, epochId === undefined ? undefined : { epochId }) });
    }
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
      const frame = encodedNdjsonFrame(event);
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
    writeKeepAliveStreamHead(response, {
      cacheControl: 'no-store',
      contentType: 'application/x-ndjson; charset=utf-8',
    });
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
