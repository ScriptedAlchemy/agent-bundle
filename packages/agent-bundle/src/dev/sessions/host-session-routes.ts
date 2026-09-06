import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type HostAvailability,
  type HostSession,
  type HostSessionHost,
  type HostSessionLaunchRequest,
  type HostSessionSize,
  isHostSessionId,
} from '../../contracts/host-sessions.ts';
import {
  createBackpressuredWriter,
  writeKeepAliveStreamHead,
} from '../route-streams.ts';
import {
  decodedOpaqueSegment,
  diagnostic,
  hasOnly,
  noQuery,
  rawPathname,
  readJsonBody,
  requestError,
  responseDiagnostic,
  responseJson,
} from '../http.ts';
import {
  HOST_SESSION_MALFORMED_CODE,
  HOST_SESSION_UNAVAILABLE_CODE,
  HOST_SESSION_UNKNOWN_CODE,
  HostSessionError,
  type HostSessionStreamMessage,
} from './host-session-service.ts';

const invalid = (): never => {
  throw requestError(diagnostic(HOST_SESSION_MALFORMED_CODE, 'Host-session request has an invalid shape.', 400));
};

type SessionPath =
  | Readonly<{ readonly kind: 'collection' }>
  | Readonly<{ readonly id: string; readonly kind: 'item' | 'stream' | 'input' | 'resize' | 'terminate' | 'restart' }>;

const sessionPath = (target: string | undefined): SessionPath | undefined => {
  const pathname = rawPathname(target);
  if (pathname !== '/api/sessions' && !pathname.startsWith('/api/sessions/')) return undefined;
  if (pathname === '/api/sessions') return { kind: 'collection' };
  const parts = pathname.split('/');
  if ((parts.length !== 4 && parts.length !== 5) || parts[3] === undefined) invalid();
  const id = decodedOpaqueSegment(parts[3], {
    code: HOST_SESSION_MALFORMED_CODE,
    maxLength: 19,
    message: 'Host-session path is not valid.',
    rejectBlank: true,
  });
  if (!isHostSessionId(id)) invalid();
  if (parts.length === 4) return { id, kind: 'item' };
  const action = parts[4];
  switch (action) {
    case 'stream':
    case 'input':
    case 'resize':
    case 'terminate':
    case 'restart':
      return { id, kind: action };
    default:
      return invalid();
  }
};

const jsonBody = (request: IncomingMessage) => readJsonBody(request, {
  invalidShape: invalid,
  read: {
    code: HOST_SESSION_MALFORMED_CODE,
    limit: 20 * 1024,
    message: 'Host-session request exceeds 20 KiB.',
  },
});

const dimensions = (value: Readonly<Record<string, unknown>>): HostSessionSize => {
  if (
    !hasOnly(value, ['cols', 'rows'])
    || !Number.isInteger(value.cols) || (value.cols as number) < 1 || (value.cols as number) > 500
    || !Number.isInteger(value.rows) || (value.rows as number) < 1 || (value.rows as number) > 500
  ) invalid();
  return { cols: value.cols as number, rows: value.rows as number };
};

const creation = (value: Readonly<Record<string, unknown>>) => {
  if (!hasOnly(value, ['cols', 'host', 'prompt', 'rows'])) invalid();
  if (value.host !== 'claude' && value.host !== 'codex') invalid();
  // The prompt is the host's positional argument: a leading dash would be parsed as an option.
  if (value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.trim() === '' || value.prompt.startsWith('-'))) invalid();
  return {
    ...dimensions({ cols: value.cols, rows: value.rows }),
    host: value.host as HostSessionHost,
    ...(value.prompt === undefined ? {} : { prompt: value.prompt as string }),
  };
};

export interface HostSessionRouteService {
  availability(): Promise<readonly HostAvailability[]>;
  close?(): Promise<void> | void;
  create(request: HostSessionLaunchRequest): Promise<HostSession>;
  forget(id: string): boolean;
  input(id: string, data: string): void;
  list(): readonly HostSession[];
  read(id: string): HostSession | undefined;
  resize(id: string, cols: number, rows: number): void;
  restart(id: string, size: HostSessionSize): Promise<HostSession>;
  subscribe(id: string, listener: (message: HostSessionStreamMessage) => void): () => void;
  terminate(id: string): Promise<HostSession>;
}

export interface HostSessionRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly service?: HostSessionRouteService;
}

export class HostSessionRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #service: HostSessionRouteService | undefined;
  #closed = false;

  constructor(options: HostSessionRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve(this.#service?.close?.());
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = sessionPath(request.url);
    if (path === undefined) return false;
    this.#authorize(request);
    if (this.#closed || this.#service === undefined) {
      throw requestError(diagnostic(HOST_SESSION_UNAVAILABLE_CODE, 'Host-session routes are not available.', 503));
    }
    const service = this.#service;
    const method = request.method ?? 'GET';
    noQuery(request.url, invalid);
    try {
      if (path.kind === 'collection' && method === 'GET') {
        responseJson(response, { hosts: await service.availability(), sessions: service.list() });
        return true;
      }
      if (path.kind === 'collection' && method === 'POST') {
        responseJson(response, { session: await service.create(creation(await jsonBody(request))) }, { status: 201 });
        return true;
      }
      if (path.kind === 'item' && method === 'GET') {
        const session = service.read(path.id);
        if (session === undefined) throw new HostSessionError(HOST_SESSION_UNKNOWN_CODE, `Host session ${JSON.stringify(path.id)} was not found.`, 404);
        responseJson(response, { session });
        return true;
      }
      if (path.kind === 'item' && method === 'DELETE') {
        service.forget(path.id);
        response.writeHead(204).end();
        return true;
      }
      if (path.kind === 'stream' && method === 'GET') {
        this.#stream(service, path.id, response);
        return true;
      }
      if (path.kind === 'input' && method === 'POST') {
        const body = await jsonBody(request);
        if (!hasOnly(body, ['data']) || typeof body.data !== 'string') invalid();
        service.input(path.id, body.data as string);
        response.writeHead(204).end();
        return true;
      }
      if (path.kind === 'resize' && method === 'POST') {
        const size = dimensions(await jsonBody(request));
        service.resize(path.id, size.cols, size.rows);
        response.writeHead(204).end();
        return true;
      }
      if (path.kind === 'terminate' && method === 'POST') {
        const body = await jsonBody(request);
        if (!hasOnly(body, [])) invalid();
        responseJson(response, { session: await service.terminate(path.id) });
        return true;
      }
      if (path.kind === 'restart' && method === 'POST') {
        responseJson(response, { session: await service.restart(path.id, dimensions(await jsonBody(request))) }, { status: 201 });
        return true;
      }
    } catch (error) {
      if (error instanceof HostSessionError) {
        throw requestError(diagnostic(error.code, error.message, error.status));
      }
      throw error;
    }
    responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    return true;
  }

  #stream(service: HostSessionRouteService, id: string, response: ServerResponse): void {
    let terminal = false;
    const stream: {
      keepAlive?: ReturnType<typeof setInterval>;
      unsubscribe?: () => void;
    } = {};
    const finish = (): void => {
      if (!terminal || !writer.idle || response.writableEnded || response.destroyed) return;
      if (stream.keepAlive !== undefined) clearInterval(stream.keepAlive);
      stream.unsubscribe?.();
      response.end();
    };
    const writer = createBackpressuredWriter(response, {
      byteLimit: 256 * 1024,
      onIdle: finish,
      recordLimit: 128,
    });
    const deliver = (message: HostSessionStreamMessage): void => {
      const type = message.type;
      const result = writer.enqueue(`event: ${type}\ndata: ${JSON.stringify(
        type === 'output' ? { data: message.data } : { session: message.session },
      )}\n\n`);
      if (result === 'overflow') response.destroy();
      if (type === 'end') terminal = true;
      finish();
    };
    response.once('close', () => {
      writer.markClosed();
      if (stream.keepAlive !== undefined) clearInterval(stream.keepAlive);
      stream.unsubscribe?.();
    });
    if (service.read(id) === undefined) throw new HostSessionError(HOST_SESSION_UNKNOWN_CODE, `Host session ${JSON.stringify(id)} was not found.`, 404);
    writeKeepAliveStreamHead(response, {
      cacheControl: 'no-cache',
      contentType: 'text/event-stream; charset=utf-8',
    });
    stream.unsubscribe = service.subscribe(id, deliver);
    stream.keepAlive = terminal ? undefined : setInterval(() => writer.enqueue(': keep-alive\n\n'), 15_000);
    finish();
  }
}
