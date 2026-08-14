import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type { ProjectEventHub } from './events.ts';
import type { Invalidation, ProjectEventMessage, ProjectStatus } from './types.ts';

const bodyLimit = 64 * 1024;
const loopbackHosts = new Set(['127.0.0.1', '::1']);

export type ForegroundServerErrorCode = 'AB8000';

/** Configuration errors that prevent a foreground server from starting. */
export class ForegroundServerError extends Error {
  readonly code: ForegroundServerErrorCode;

  constructor(code: ForegroundServerErrorCode, message: string) {
    super(message);
    this.name = 'ForegroundServerError';
    this.code = code;
  }
}

export interface ForegroundServerCloseFailure {
  readonly error: unknown;
  readonly resource: 'coordinator' | 'server';
}

/** Reports all releases that failed after every foreground resource was asked to close. */
export class ForegroundServerCloseError extends Error {
  readonly failures: readonly ForegroundServerCloseFailure[];

  constructor(failures: readonly ForegroundServerCloseFailure[]) {
    super('Foreground server could not close every resource.');
    this.name = 'ForegroundServerCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

/** The small coordinator surface required by foreground HTTP routes. */
export interface ForegroundCoordinator {
  close(): Promise<void>;
  rebuild(invalidation: Invalidation): Promise<unknown>;
  start(): Promise<unknown>;
  status(): ProjectStatus;
}

export interface WorkbenchAsset {
  readonly body: string | Uint8Array;
  readonly contentType: string;
}

/** W10 supplies prebuilt workbench files through this transport-neutral lookup. */
export interface WorkbenchAssetSource {
  read(path: string): Promise<WorkbenchAsset | undefined>;
}

export interface ForegroundServerOptions {
  readonly assets?: WorkbenchAssetSource;
  readonly coordinator: ForegroundCoordinator;
  readonly eventHub: ProjectEventHub;
  readonly host?: string;
  readonly now?: () => Date;
  readonly port?: number;
  /** Injectable only to make integration contracts deterministic. */
  readonly sessionToken?: string;
}

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
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

const readBody = async (request: IncomingMessage): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
  let size = 0;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > bodyLimit) {
      rejectPromise(requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400)));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.once('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
  request.once('error', rejectPromise);
});

const decodedAssetPath = (requestTarget: string | undefined): string => {
  const pathname = requestTarget?.split(/[?#]/u, 1)[0];
  if (pathname === undefined || !pathname.startsWith('/')) {
    throw requestError(diagnostic('AB8005', 'Asset path is not valid.', 400));
  }
  if (pathname === '/') return 'index.html';

  const parts = pathname.slice(1).split('/').map((part) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw requestError(diagnostic('AB8005', 'Asset path is not valid.', 400));
    }
    if (
      decoded.length === 0 || decoded === '.' || decoded === '..' ||
      decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
    ) {
      throw requestError(diagnostic('AB8005', 'Asset path is not valid.', 400));
    }
    return decoded;
  });
  return parts.join('/');
};

const manualInvalidation = (body: string, now: () => Date): Invalidation => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError(diagnostic('AB8002', 'Request body may contain only an optional paths array.', 400));
  }
  const fields = Object.keys(value);
  if (fields.some((field) => field !== 'paths')) {
    throw requestError(diagnostic('AB8002', 'Request body may contain only an optional paths array.', 400));
  }
  const paths = (value as { readonly paths?: unknown }).paths ?? [];
  if (!Array.isArray(paths) || paths.some((path) => !isProjectRelativePath(path))) {
    throw requestError(diagnostic('AB8002', 'Request body may contain only an optional paths array.', 400));
  }
  return Object.freeze({
    occurredAt: now().toISOString(),
    paths: Object.freeze([...new Set(paths)].sort((left, right) => left.localeCompare(right))),
    reason: 'manual',
  });
};

const isProjectRelativePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
};

const eventFrame = (event: ProjectEventMessage): string => {
  const id = event.type === 'replay.gap' ? '' : `id: ${event.sequence}\n`;
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
};

const afterSequence = (request: IncomingMessage, latestSequence: number): number => {
  const header = singleHeader(request.headers['last-event-id']);
  if (header === undefined || header.length === 0) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(header)) {
    throw requestError(diagnostic('AB8006', 'Last-Event-ID must be a non-negative integer.', 400));
  }
  const sequence = Number(header);
  if (!Number.isSafeInteger(sequence) || sequence > latestSequence) {
    throw requestError(diagnostic('AB8006', 'Last-Event-ID must not be ahead of the project event stream.', 400));
  }
  return sequence;
};

const closeServer = (server: Server): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
});

/**
 * A foreground-only HTTP transport. It starts no executable selected by the
 * browser: product work stays in the injected coordinator.
 */
export class ForegroundServer {
  readonly #assets: WorkbenchAssetSource | undefined;
  readonly #coordinator: ForegroundCoordinator;
  readonly #eventHub: ProjectEventHub;
  readonly #host: string;
  readonly #now: () => Date;
  readonly #port: number;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #closePromise: Promise<void> | undefined;
  #listening = false;
  #startPromise: Promise<void> | undefined;
  #url: string | undefined;

  constructor(options: ForegroundServerOptions) {
    const host = options.host ?? '127.0.0.1';
    if (!loopbackHosts.has(host)) {
      throw new ForegroundServerError('AB8000', 'Foreground servers may bind only to 127.0.0.1 or ::1.');
    }
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      throw new ForegroundServerError('AB8000', 'Foreground server port must be a safe TCP port number.');
    }

    this.#assets = options.assets;
    this.#coordinator = options.coordinator;
    this.#eventHub = options.eventHub;
    this.#host = host;
    this.#now = options.now ?? (() => new Date());
    this.#port = port;
    this.sessionToken = options.sessionToken ?? randomUUID();
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        responseDiagnostic(
          response,
          isRequestDiagnostic(error)
            ? error
            : diagnostic('AB8007', 'Request could not be completed.', 500),
        );
      });
    });
    this.#server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
  }

  /** Browser-only capability, disclosed solely through same-origin bootstrap. */
  readonly sessionToken: string;

  get url(): string {
    if (this.#url === undefined) throw new Error('Foreground server has not started.');
    return this.#url;
  }

  async start(): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<void> {
    try {
      await this.#coordinator.start();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const fail = (error: Error) => {
          this.#server.off('listening', succeed);
          rejectPromise(error);
        };
        const succeed = () => {
          this.#server.off('error', fail);
          resolvePromise();
        };
        this.#server.once('error', fail);
        this.#server.once('listening', succeed);
        this.#server.listen({ host: this.#host, port: this.#port });
      });
      const address = this.#server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Foreground server did not report a TCP address.');
      }
      this.#listening = true;
      this.#url = `http://${addressToHost(address)}:${address.port}`;
    } catch (error) {
      await Promise.allSettled([this.close()]);
      throw error;
    }
  }

  async #close(): Promise<void> {
    const releaseServer = this.#listening
      ? (() => {
          this.#listening = false;
          for (const socket of this.#sockets) socket.destroy();
          return closeServer(this.#server);
        })()
      : Promise.resolve();
    const [server, coordinator] = await Promise.allSettled([releaseServer, this.#coordinator.close()]);
    const failures: ForegroundServerCloseFailure[] = [];
    if (server.status === 'rejected') failures.push(Object.freeze({ error: server.reason, resource: 'server' }));
    if (coordinator.status === 'rejected') failures.push(Object.freeze({ error: coordinator.reason, resource: 'coordinator' }));
    if (failures.length > 0) throw new ForegroundServerCloseError(failures);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', this.url).pathname;
    const method = request.method ?? 'GET';
    if (pathname === '/api/project/status') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { status: this.#coordinator.status() });
    }
    if (pathname === '/api/project/session') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      this.#assertSessionBootstrapOrigin(request);
      return responseJson(response, { origin: this.url, token: this.sessionToken });
    }
    if (pathname === '/api/project/rebuild') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      this.#assertMutationSession(request);
      await this.#coordinator.rebuild(manualInvalidation(await readBody(request), this.#now));
      return responseJson(response, { status: this.#coordinator.status() });
    }
    if (pathname === '/api/project/events') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return this.#streamEvents(request, response);
    }
    return this.#serveAsset(request, response, method);
  }

  #assertSessionBootstrapOrigin(request: IncomingMessage): void {
    const origin = singleHeader(request.headers.origin);
    if (origin === this.url) return;
    if (origin === undefined && singleHeader(request.headers['sec-fetch-site']) === 'same-origin') return;
    throw requestError(diagnostic('AB8003', 'Request origin is not this foreground server.', 403));
  }

  #assertMutationSession(request: IncomingMessage): void {
    if (singleHeader(request.headers.origin) !== this.url) {
      throw requestError(diagnostic('AB8003', 'Request origin is not this foreground server.', 403));
    }
    if (singleHeader(request.headers['x-agent-bundle-session']) !== this.sessionToken) {
      throw requestError(diagnostic('AB8004', 'A valid same-session token is required.', 403));
    }
  }

  #streamEvents(request: IncomingMessage, response: ServerResponse): void {
    const sequence = afterSequence(request, this.#eventHub.latestSequence);
    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    const subscription = this.#eventHub.subscribe({ afterSequence: sequence }, (event) => {
      if (!response.writableEnded && !response.destroyed) response.write(eventFrame(event));
    });
    const unsubscribe = () => subscription.unsubscribe();
    request.once('close', unsubscribe);
    response.once('close', unsubscribe);
    if (request.destroyed || response.destroyed) subscription.unsubscribe();
  }

  async #serveAsset(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    const path = decodedAssetPath(request.url);
    const asset = await this.#assets?.read(path);
    if (asset === undefined) return responseDiagnostic(response, diagnostic('AB8007', 'Route was not found.', 404));
    response.writeHead(200, { 'content-type': asset.contentType });
    response.end(method === 'HEAD' ? undefined : asset.body);
  }
}

const addressToHost = (address: AddressInfo): string => address.family === 'IPv6'
  ? `[${address.address}]`
  : address.address;

export const startForegroundServer = async (options: ForegroundServerOptions): Promise<ForegroundServer> => {
  const server = new ForegroundServer(options);
  await server.start();
  return server;
};
