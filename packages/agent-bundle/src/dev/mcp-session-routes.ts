import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  McpSessionBinding,
  McpSessionConnectionState,
  McpSessionInspectorConfig,
  McpSessionTraceReplay,
  McpSessionTraceSubscription,
} from './mcp-session-service.ts';

const bodyLimit = 64 * 1024;
const streamQueueByteLimit = 256 * 1024;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

interface QueuedFrame {
  readonly bytes: number;
  readonly frame: string;
}

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
  open(options: { readonly epochId: string; readonly serverName: string; readonly target: string }): Promise<McpSessionRouteSession>;
}

export interface McpSessionRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench service composes a persistent MCP session service. */
  readonly service?: McpSessionRouteService;
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
    throw requestError(diagnostic('AB8013', 'MCP session route path is not valid.', 400));
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) {
    throw requestError(diagnostic('AB8013', 'MCP session route path is not valid.', 400));
  }
  return decoded;
};

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

const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnly = (value: JsonObject, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');

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
  if (!isRecord(parsed)) invalidShape();
  return parsed;
};

const createRequest = (value: JsonObject): { readonly epochId: string; readonly serverName: string; readonly target: string } => {
  if (!hasOnly(value, ['epochId', 'serverName', 'target'])) invalidShape();
  const { epochId, serverName, target } = value;
  if (!nonemptyString(epochId) || !nonemptyString(serverName) || !nonemptyString(target)) invalidShape();
  if (target !== 'portable' && target !== 'codex' && target !== 'claude') invalidShape();
  return Object.freeze({ epochId, serverName, target });
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
    if (!hasOnly(value, ['operation'])) invalidShape();
    return Object.freeze({ operation });
  }
  if (operation === 'tools/list' || operation === 'resources/list' || operation === 'resources/templates/list' || operation === 'prompts/list') {
    if (!hasOnly(value, ['operation'])) invalidShape();
    return Object.freeze({ operation });
  }
  if (operation === 'prompts/get') {
    if (!hasOnly(value, ['arguments', 'name', 'operation']) || !nonemptyString(value.name)) invalidShape();
    if (value.arguments !== undefined && !stringRecord(value.arguments)) invalidShape();
    return Object.freeze({
      ...(value.arguments === undefined ? {} : { arguments: value.arguments }),
      name: value.name,
      operation,
    });
  }
  if (operation === 'resources/read') {
    if (!hasOnly(value, ['operation', 'uri']) || !nonemptyString(value.uri)) invalidShape();
    return Object.freeze({ operation, uri: value.uri });
  }
  if (operation === 'tools/call') {
    if (!hasOnly(value, ['arguments', 'name', 'operation', 'requestId']) || !nonemptyString(value.name) || !jsonRecord(value.arguments)) {
      invalidShape();
    }
    if (value.requestId !== undefined && !nonemptyString(value.requestId)) invalidShape();
    return Object.freeze({
      arguments: value.arguments,
      name: value.name,
      operation,
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
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
}> => Object.freeze({ binding: session.binding, connection: session.connection, id: session.id });

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
      if (!hasOnly(body, ['requestId']) || !nonemptyString(body.requestId)) invalidShape();
      return responseJson(response, { cancelled: session.cancel(body.requestId) });
    }
    const closed = await service.closeSession(parsed.id);
    if (!closed) throw this.#unavailable();
    this.#closeStreams(parsed.id);
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
    return session.callTool({
      arguments: operation.arguments,
      name: operation.name,
      ...(operation.requestId === undefined ? {} : { requestId: operation.requestId }),
    });
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
    response.writeHead(200, {
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'content-type': 'application/x-ndjson; charset=utf-8',
    });
    response.flushHeaders();

    let backpressured = false;
    let bufferedBytes = 0;
    let closed = false;
    let queuedBytes = 0;
    const stream = { subscription: undefined as McpSessionTraceSubscription | undefined };
    const queued: QueuedFrame[] = [];
    let cleanup = (): void => undefined;
    const finishStream = (): void => {
      if (closed) return;
      cleanup();
      if (!response.writableEnded && !response.destroyed) response.end();
    };
    const drain = (): void => {
      if (closed || response.writableEnded || response.destroyed) return;
      backpressured = false;
      bufferedBytes = 0;
      while (queued.length > 0) {
        const next = queued.shift()!;
        queuedBytes -= next.bytes;
        if (!response.write(next.frame)) {
          backpressured = true;
          bufferedBytes = next.bytes;
          response.once('drain', drain);
          return;
        }
      }
    };
    const abortStream = (): void => {
      if (closed) return;
      cleanup();
      response.destroy();
    };
    const deliver = (entry: unknown): void => {
      if (closed || response.writableEnded || response.destroyed) return;
      const frame = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.byteLength(frame);
      if (bytes > streamQueueByteLimit) {
        abortStream();
        return;
      }
      if (!backpressured) {
        if (!response.write(frame)) {
          backpressured = true;
          bufferedBytes = bytes;
          response.once('drain', drain);
        }
        return;
      }
      if (bufferedBytes + queuedBytes + bytes > streamQueueByteLimit) {
        abortStream();
        return;
      }
      queued.push({ bytes, frame });
      queuedBytes += bytes;
    };
    cleanup = (): void => {
      if (closed) return;
      closed = true;
      stream.subscription?.unsubscribe();
      queued.length = 0;
      queuedBytes = 0;
      bufferedBytes = 0;
      this.#removeStream(id, finishStream);
    };
    stream.subscription = session.subscribeTrace({ afterSequence }, deliver);
    if (closed || request.destroyed || response.destroyed) {
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
