import type { IncomingMessage, ServerResponse } from 'node:http';

import { isRecord } from '../core/strict-json.ts';
import {
  decodedOpaqueSegment,
  diagnostic,
  hasOnly,
  isJsonRequest,
  isRequestDiagnostic,
  nonemptyString,
  rawPathname,
  readBody,
  requestError,
  responseDiagnostic,
  responseJson,
  type RequestDiagnostic,
} from './http.ts';
import type {
  McpSessionBinding,
  McpSessionConnectionState,
  McpSessionInspectorConfig,
  McpSessionTraceReplay,
  McpSessionTraceSubscription,
} from './mcp-session-service.ts';
import { createBackpressuredWriter, encodedNdjsonFrame, writeKeepAliveStreamHead } from './route-streams.ts';

const streamQueueByteLimit = 256 * 1024;

interface CreateRoute {
  readonly kind: 'create';
}

interface SessionRoute {
  readonly id: string;
  readonly kind: 'session' | 'connection' | 'catalog' | 'config' | 'operations' | 'trace' | 'stream' | 'restart' | 'cancel';
}

type Route = CreateRoute | SessionRoute;

type JsonObject = Record<string, unknown>;

export interface McpSessionRouteSession {
  readonly binding: McpSessionBinding;
  readonly connection: McpSessionConnectionState;
  readonly id: string;
  readonly timeoutMs: number;
  callTool(options: { readonly arguments: Record<string, unknown>; readonly name: string; readonly requestId?: string }): Promise<unknown>;
  cancel(requestId: string): boolean;
  getPrompt(options: { readonly arguments?: Record<string, string>; readonly name: string }): Promise<unknown>;
  inspectorConfig(): McpSessionInspectorConfig;
  listPrompts(): Promise<readonly unknown[]>;
  listResources(): Promise<readonly unknown[]>;
  listResourceTemplates(): Promise<readonly unknown[]>;
  listTools(): Promise<readonly unknown[]>;
  readResource(options: { readonly uri: string }): Promise<unknown>;
  restart(): Promise<McpSessionConnectionState>;
  subscribeTrace(
    options: { readonly afterSequence?: number },
    listener: (entry: unknown) => void,
  ): McpSessionTraceSubscription;
  trace(afterSequence?: number): McpSessionTraceReplay;
}

export interface McpSessionRouteService {
  closeSession(id: string): Promise<boolean>;
  get(id: string): McpSessionRouteSession | undefined;
  open(options: { readonly epochId: string; readonly serverName: string; readonly target: string; readonly timeoutMs?: number }): Promise<McpSessionRouteSession>;
}

export interface McpSessionRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench service composes a persistent MCP session service. */
  readonly service?: McpSessionRouteService;
}

const decodedSegment = (segment: string): string =>
  decodedOpaqueSegment(segment, { code: 'AB8013', message: 'MCP session route path is not valid.' });

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/mcp' && !pathname.startsWith('/api/mcp/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'mcp') {
    throw requestError(diagnostic('AB8013', 'MCP session route path is not valid.', 400));
  }
  const segments = parts.slice(3).map(decodedSegment);
  if (segments.length === 1 && segments[0] === 'sessions') return Object.freeze({ kind: 'create' });
  if (segments[0] !== 'sessions' || segments[1] === undefined) {
    throw requestError(diagnostic('AB8013', 'MCP session route path is not valid.', 400));
  }
  const id = segments[1];
  if (segments.length === 2) return Object.freeze({ id, kind: 'session' });
  if (segments.length !== 3) throw requestError(diagnostic('AB8013', 'MCP session route path is not valid.', 400));
  const kind = segments[2];
  if (
    kind !== 'connection' && kind !== 'catalog' && kind !== 'config' && kind !== 'operations' && kind !== 'trace' &&
    kind !== 'stream' && kind !== 'restart' && kind !== 'cancel'
  ) {
    throw requestError(diagnostic('AB8013', 'MCP session route path is not valid.', 400));
  }
  return Object.freeze({ id, kind });
};

const stringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

const jsonRecord = (value: unknown): value is Record<string, unknown> => isRecord(value);

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8016', 'MCP session request has an invalid shape.', 400));
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

const createRequest = (value: JsonObject): { readonly epochId: string; readonly serverName: string; readonly target: string; readonly timeoutMs?: number } => {
  if (!hasOnly(value, ['epochId', 'serverName', 'target', 'timeoutMs'])) return invalidShape();
  const { epochId, serverName, target } = value;
  if (!nonemptyString(epochId)) return invalidShape();
  if (!nonemptyString(serverName)) return invalidShape();
  if (!nonemptyString(target)) return invalidShape();
  if (!Object.hasOwn(value, 'timeoutMs')) return Object.freeze({ epochId, serverName, target });
  const descriptor = Object.getOwnPropertyDescriptor(value, 'timeoutMs');
  if (descriptor === undefined || !('value' in descriptor)) return invalidShape();
  const timeoutMs = descriptor.value;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return invalidShape();
  return Object.freeze({ epochId, serverName, target, timeoutMs });
};

type Operation =
  | Readonly<{ readonly operation: 'initialize' }>
  | Readonly<{ readonly operation: 'tools/list' | 'resources/list' | 'resources/templates/list' | 'prompts/list' }>
  | Readonly<{ readonly arguments?: Record<string, string>; readonly name: string; readonly operation: 'prompts/get' }>
  | Readonly<{ readonly operation: 'resources/read'; readonly uri: string }>
  | Readonly<{ readonly arguments: Record<string, unknown>; readonly name: string; readonly operation: 'tools/call'; readonly requestId?: string }>;

const operationRequest = (value: JsonObject): Operation => {
  const operation = value.operation;
  if (operation === 'initialize') {
    if (!hasOnly(value, ['operation'])) return invalidShape();
    return Object.freeze({ operation });
  }
  if (operation === 'tools/list' || operation === 'resources/list' || operation === 'resources/templates/list' || operation === 'prompts/list') {
    if (!hasOnly(value, ['operation'])) return invalidShape();
    return Object.freeze({ operation });
  }
  if (operation === 'prompts/get') {
    if (!hasOnly(value, ['arguments', 'name', 'operation'])) return invalidShape();
    const name = value.name;
    const argumentsValue = value.arguments;
    if (!nonemptyString(name)) return invalidShape();
    if (argumentsValue !== undefined && !stringRecord(argumentsValue)) return invalidShape();
    return Object.freeze({
      ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
      name,
      operation,
    });
  }
  if (operation === 'resources/read') {
    if (!hasOnly(value, ['operation', 'uri'])) return invalidShape();
    const uri = value.uri;
    if (!nonemptyString(uri)) return invalidShape();
    return Object.freeze({ operation, uri });
  }
  if (operation === 'tools/call') {
    if (!hasOnly(value, ['arguments', 'name', 'operation', 'requestId'])) return invalidShape();
    const argumentsValue = value.arguments;
    const name = value.name;
    const requestId = value.requestId;
    if (!nonemptyString(name) || !jsonRecord(argumentsValue)) return invalidShape();
    if (requestId !== undefined && !nonemptyString(requestId)) return invalidShape();
    return Object.freeze({
      arguments: argumentsValue,
      name,
      operation,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  return invalidShape();
};

const queryCursor = (requestTarget: string | undefined): number => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  const keys = [...query.keys()];
  if (keys.some((key) => key !== 'after') || query.getAll('after').length > 1) {
    throw requestError(diagnostic('AB8017', 'MCP session trace cursor is not valid.', 400));
  }
  const value = query.get('after');
  if (value === null) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw requestError(diagnostic('AB8017', 'MCP session trace cursor is not valid.', 400));
  }
  const after = Number(value);
  if (!Number.isSafeInteger(after)) {
    throw requestError(diagnostic('AB8017', 'MCP session trace cursor is not valid.', 400));
  }
  return after;
};

const sessionSnapshot = (session: McpSessionRouteSession): Readonly<{
  readonly binding: McpSessionBinding;
  readonly connection: McpSessionConnectionState;
  readonly id: string;
  readonly timeoutMs: number;
}> => Object.freeze({ binding: session.binding, connection: session.connection, id: session.id, timeoutMs: session.timeoutMs });

const traceCursorError = (error: unknown): RequestDiagnostic | undefined =>
  error instanceof RangeError && error.message === 'MCP session trace cursor cannot be ahead of the current trace.'
    ? diagnostic('AB8017', 'MCP session trace cursor is ahead of the current trace.', 409)
    : error instanceof RangeError && error.message === 'MCP session trace cursor must be a nonnegative safe integer.'
      ? diagnostic('AB8017', 'MCP session trace cursor is not valid.', 400)
      : undefined;

const closedSessionError = (error: unknown): boolean => error instanceof Error && error.message === 'MCP session is closed.';

/**
 * HTTP boundary for the deliberately small browser MCP operation contract.
 * It never turns browser input into a launcher, environment, source path, or
 * arbitrary JSON-RPC frame; the epoch-bound service owns those capabilities.
 */
export class McpSessionRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #service: McpSessionRouteService | undefined;
  readonly #streamClosers = new Map<string, Set<() => void>>();
  #closed = false;

  constructor(options: McpSessionRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const closers of this.#streamClosers.values()) {
      for (const close of closers) close();
    }
    this.#streamClosers.clear();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closed) throw requestError(diagnostic('AB8014', 'MCP session routes are not available.', 503));
    const service = this.#service;
    if (service === undefined) throw requestError(diagnostic('AB8014', 'MCP session routes are not available.', 404));
    try {
      await this.#dispatch(parsed, request, response, service);
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      const cursor = traceCursorError(error);
      if (cursor !== undefined) throw requestError(cursor);
      if (closedSessionError(error)) throw this.#unavailable();
      if (parsed.kind === 'create') {
        throw requestError(diagnostic('AB8019', 'MCP session could not be opened.', 400));
      }
      throw requestError(diagnostic('AB8019', 'MCP session operation could not be completed.', 502));
    }
    return true;
  }

  async #dispatch(
    parsed: Route,
    request: IncomingMessage,
    response: ServerResponse,
    service: McpSessionRouteService,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    if (parsed.kind === 'create') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const session = await service.open(createRequest(await jsonBody(request)));
      return responseJson(response, { session: sessionSnapshot(session) });
    }

    const session = this.#session(service, parsed.id);
    if (parsed.kind === 'session') {
      if (method === 'GET') return responseJson(response, { session: sessionSnapshot(session) });
      if (method !== 'DELETE') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    if (parsed.kind === 'connection') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { connection: session.connection });
    }
    if (parsed.kind === 'catalog') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const [tools, resources, resourceTemplates, prompts] = await Promise.all([
        session.listTools(),
        session.listResources(),
        session.listResourceTemplates(),
        session.listPrompts(),
      ]);
      return responseJson(response, { prompts, resourceTemplates, resources, tools });
    }
    if (parsed.kind === 'config') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { config: session.inspectorConfig() });
    }
    if (parsed.kind === 'operations') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { result: await this.#operation(session, operationRequest(await jsonBody(request))) });
    }
    if (parsed.kind === 'trace') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { trace: session.trace(queryCursor(request.url)) });
    }
    if (parsed.kind === 'stream') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return this.#stream(session, parsed.id, queryCursor(request.url), request, response);
    }
    if (parsed.kind === 'restart') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      if (!hasOnly(await jsonBody(request), [])) invalidShape();
      return responseJson(response, { connection: await session.restart() });
    }
    if (parsed.kind === 'cancel') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const body = await jsonBody(request);
      if (!hasOnly(body, ['requestId'])) return invalidShape();
      const requestId = body.requestId;
      if (!nonemptyString(requestId)) return invalidShape();
      return responseJson(response, { cancelled: session.cancel(requestId) });
    }
    try {
      if (!await service.closeSession(parsed.id)) throw this.#unavailable();
    } finally {
      // A session may remove itself before surfacing a cleanup failure.
      this.#closeStreams(parsed.id);
    }
    return responseJson(response, { closed: true });
  }

  #session(service: McpSessionRouteService, id: string): McpSessionRouteSession {
    return service.get(id) ?? this.#unavailable();
  }

  #unavailable(): never {
    throw requestError(diagnostic('AB8015', 'MCP session is not available.', 404));
  }

  async #operation(session: McpSessionRouteSession, operation: Operation): Promise<unknown> {
    if (operation.operation === 'initialize') return session.connection;
    if (operation.operation === 'tools/list') return session.listTools();
    if (operation.operation === 'resources/list') return session.listResources();
    if (operation.operation === 'resources/templates/list') return session.listResourceTemplates();
    if (operation.operation === 'prompts/list') return session.listPrompts();
    if (operation.operation === 'prompts/get') {
      return session.getPrompt({ ...(operation.arguments === undefined ? {} : { arguments: operation.arguments }), name: operation.name });
    }
    if (operation.operation === 'resources/read') return session.readResource({ uri: operation.uri });
    if (operation.operation === 'tools/call') {
      return session.callTool({
        arguments: operation.arguments,
        name: operation.name,
        ...(operation.requestId === undefined ? {} : { requestId: operation.requestId }),
      });
    }
    return invalidShape();
  }

  #stream(
    session: McpSessionRouteSession,
    id: string,
    afterSequence: number,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    // Validate before committing headers so an ahead cursor is a JSON diagnostic.
    session.trace(afterSequence);
    writeKeepAliveStreamHead(response, {
      cacheControl: 'no-store',
      contentType: 'application/x-ndjson; charset=utf-8',
    });

    const stream = { subscription: undefined as McpSessionTraceSubscription | undefined };
    const writer = createBackpressuredWriter(response, {
      byteLimit: streamQueueByteLimit,
      countInFlightBytes: true,
      rejectOversizedFrame: true,
    });
    let cleanup = (): void => undefined;
    const finishStream = (): void => {
      if (writer.closed) return;
      cleanup();
      if (!response.writableEnded && !response.destroyed) response.end();
    };
    const abortStream = (): void => {
      if (writer.closed) return;
      cleanup();
      response.destroy();
    };
    const deliver = (entry: unknown): void => {
      if (writer.enqueue(encodedNdjsonFrame(entry)) === 'overflow') abortStream();
    };
    cleanup = (): void => {
      if (writer.closed) return;
      writer.markClosed();
      stream.subscription?.unsubscribe();
      this.#removeStream(id, finishStream);
    };
    stream.subscription = session.subscribeTrace({ afterSequence }, deliver);
    if (writer.closed || request.destroyed || response.destroyed) {
      stream.subscription.unsubscribe();
      cleanup();
      return;
    }
    this.#addStream(id, finishStream);
    request.once('close', cleanup);
    response.once('close', cleanup);
  }

  #addStream(id: string, close: () => void): void {
    const streams = this.#streamClosers.get(id) ?? new Set<() => void>();
    streams.add(close);
    this.#streamClosers.set(id, streams);
  }

  #closeStreams(id: string): void {
    for (const close of this.#streamClosers.get(id) ?? []) close();
  }

  #removeStream(id: string, close: () => void): void {
    const streams = this.#streamClosers.get(id);
    if (streams === undefined) return;
    streams.delete(close);
    if (streams.size === 0) this.#streamClosers.delete(id);
  }
}
