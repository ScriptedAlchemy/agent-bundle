import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { basename } from 'node:path';

import type { ProjectEventHub, ProjectEventSubscription } from './events.ts';
import { HookPlaygroundRoutes, type HookPlaygroundRouteService } from './hook-playground-routes.ts';
import { McpAppRoutes, type McpAppRoutePreviewService } from './mcp-app-routes.ts';
import { McpSessionRoutes } from './mcp-session-routes.ts';
import type { McpSessionService } from './mcp-session-service.ts';
import { SkillDocumentError, type SkillDocumentService } from './skill-document-service.ts';
import type { Invalidation, ProjectEventMessage, ProjectStatus } from './types.ts';

const bodyLimit = 64 * 1024;
const loopbackHosts = new Set(['127.0.0.1', '::1']);
const sseQueueByteLimit = 256 * 1024;

interface QueuedSseFrame {
  readonly bytes: number;
  readonly frame: string;
}

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

export interface ForegroundServerStartFailure {
  readonly error: unknown;
  readonly resource: 'cleanup' | 'start';
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

/** Preserves a failed startup and every release failure needed to unwind it. */
export class ForegroundServerStartError extends Error {
  readonly failures: readonly ForegroundServerStartFailure[];

  constructor(failures: readonly ForegroundServerStartFailure[]) {
    super('Foreground server could not start cleanly.');
    this.name = 'ForegroundServerStartError';
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
  /** Already-bound MCP App previews, never executable data supplied by a browser request. */
  readonly mcpAppPreviews?: McpAppRoutePreviewService;
  /** Epoch-bound hook playground service; the browser never selects a wrapper or artifact path. */
  readonly hookPlayground?: HookPlaygroundRouteService;
  /** Persistent MCP sessions are supplied by the workbench service, never by browser input. */
  readonly mcpSessions?: McpSessionService;
  readonly now?: () => Date;
  readonly port?: number;
  /** Read-only Skill document/resource service for the workbench. */
  readonly skillDocuments?: SkillDocumentService;
  /** Injectable only to make integration contracts deterministic. */
  readonly sessionToken?: string;
}

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type SkillRoute =
  | Readonly<{ readonly kind: 'source-tree' }>
  | Readonly<{ readonly kind: 'source-document'; readonly skillId: string }>
  | Readonly<{ readonly kind: 'source-resource'; readonly skillId: string; readonly resource: readonly string[] }>
  | Readonly<{ readonly epochId: string; readonly kind: 'generated-tree'; readonly target: string }>
  | Readonly<{ readonly epochId: string; readonly kind: 'generated-document'; readonly skillId: string; readonly target: string }>
  | Readonly<{ readonly epochId: string; readonly kind: 'generated-resource'; readonly resource: readonly string[]; readonly skillId: string; readonly target: string }>;

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

const attachmentHeader = (relativePath: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(basename(relativePath)).replaceAll("'", '%27')}`;

const singleHeader = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

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
  const rawValue = parameter.slice(equals + 1).trim();
  const value = unquoteHeaderValue(rawValue);
  return value?.toLowerCase() === 'utf-8';
};

const unquoteHeaderValue = (value: string): string | undefined => {
  if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)) return value;
  if (!/^"(?:[^"\\\r\n]|\\[\t !-~])*"$/u.test(value)) return undefined;
  return value.slice(1, -1).replace(/\\([\t !-~])/gu, '$1');
};

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

const rawPathname = (requestTarget: string | undefined): string =>
  requestTarget?.split(/[?#]/u, 1)[0] ?? '';

const decodedSkillSegment = (segment: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  return decoded;
};

const skillRoute = (requestTarget: string | undefined): SkillRoute | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/skills' && !pathname.startsWith('/api/skills/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'skills') {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  const segments = parts.slice(3).map(decodedSkillSegment);
  if (segments.length === 1 && segments[0] === 'source') return Object.freeze({ kind: 'source-tree' });
  if (segments[0] === 'source') {
    const skillId = segments[1];
    if (skillId === undefined) throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
    if (segments.length === 2) return Object.freeze({ kind: 'source-document', skillId });
    if (segments[2] === 'resources' && segments.length > 3) {
      return Object.freeze({ kind: 'source-resource', resource: Object.freeze(segments.slice(3)), skillId });
    }
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  if (segments[0] !== 'epochs') {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  const [_, epochId, target, skillId, resourceMarker, ...resource] = segments;
  if (epochId === undefined || target === undefined) {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  if (segments.length === 3) return Object.freeze({ epochId, kind: 'generated-tree', target });
  if (skillId === undefined) throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  if (segments.length === 4) return Object.freeze({ epochId, kind: 'generated-document', skillId, target });
  if (resourceMarker === 'resources' && resource.length > 0) {
    return Object.freeze({ epochId, kind: 'generated-resource', resource: Object.freeze(resource), skillId, target });
  }
  throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
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
  server.close((error) => error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
    ? resolvePromise()
    : rejectPromise(error));
});

const closedError = (): Error => new Error('Foreground server is closed.');

const requestHostMatches = (request: IncomingMessage, origin: string): boolean => {
  const host = singleHeader(request.headers.host);
  if (host === undefined) return false;
  try {
    const requested = new URL(`http://${host}`);
    const expected = new URL(origin);
    return requested.username.length === 0 && requested.password.length === 0 &&
      requested.pathname === '/' && requested.search.length === 0 && requested.hash.length === 0 &&
      requested.hostname === expected.hostname && requested.port === expected.port;
  } catch {
    return false;
  }
};

/**
 * A foreground-only HTTP transport. It starts no executable selected by the
 * browser: product work stays in the injected coordinator.
 */
export class ForegroundServer {
  readonly #assets: WorkbenchAssetSource | undefined;
  readonly #coordinator: ForegroundCoordinator;
  readonly #eventHub: ProjectEventHub;
  readonly #hookPlaygroundRoutes: HookPlaygroundRoutes;
  readonly #host: string;
  readonly #mcpAppRoutes: McpAppRoutes;
  readonly #mcpSessionRoutes: McpSessionRoutes;
  readonly #now: () => Date;
  readonly #port: number;
  readonly #server: Server;
  readonly #skillDocuments: SkillDocumentService | undefined;
  readonly #sockets = new Set<Socket>();
  readonly #streamSubscriptions = new Set<ProjectEventSubscription>();
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #listenStarted = false;
  #releasePromise: Promise<readonly ForegroundServerCloseFailure[]> | undefined;
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
    this.#skillDocuments = options.skillDocuments;
    this.sessionToken = options.sessionToken ?? randomUUID();
    this.#mcpAppRoutes = new McpAppRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.mcpAppPreviews === undefined ? {} : { service: options.mcpAppPreviews }),
    });
    this.#mcpSessionRoutes = new McpSessionRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.mcpSessions === undefined ? {} : { service: options.mcpSessions }),
    });
    this.#hookPlaygroundRoutes = new HookPlaygroundRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.hookPlayground === undefined ? {} : { service: options.hookPlayground }),
    });
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
    if (this.#closing) throw closedError();
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<void> {
    try {
      await this.#coordinator.start();
      this.#assertOpen();
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
        this.#listenStarted = true;
        this.#server.listen({ host: this.#host, port: this.#port });
      });
      this.#assertOpen();
      const address = this.#server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Foreground server did not report a TCP address.');
      }
      this.#url = `http://${addressToHost(address)}:${address.port}`;
    } catch (error) {
      if (this.#closePromise !== undefined) throw error;
      this.#closing = true;
      const cleanupFailures = await this.#releaseResources();
      if (cleanupFailures.length > 0) {
        throw new ForegroundServerStartError([
          Object.freeze({ error, resource: 'start' }),
          Object.freeze({ error: new ForegroundServerCloseError(cleanupFailures), resource: 'cleanup' }),
        ]);
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closing) throw closedError();
  }

  async #close(): Promise<void> {
    const startup = this.#startPromise;
    const failures = await this.#releaseResources();
    await startup?.catch(() => undefined);
    if (failures.length > 0) throw new ForegroundServerCloseError(failures);
  }

  #releaseResources(): Promise<readonly ForegroundServerCloseFailure[]> {
    if (this.#releasePromise !== undefined) return this.#releasePromise;
    this.#mcpAppRoutes.close();
    this.#mcpSessionRoutes.close();
    this.#hookPlaygroundRoutes.close();
    const releaseServer = this.#listenStarted
      ? (() => {
          this.#listenStarted = false;
          for (const subscription of this.#streamSubscriptions) subscription.unsubscribe();
          this.#streamSubscriptions.clear();
          for (const socket of this.#sockets) socket.destroy();
          return closeServer(this.#server);
        })()
      : Promise.resolve();
    this.#releasePromise = Promise.allSettled([releaseServer, this.#coordinator.close()]).then(([server, coordinator]) => {
      const failures: ForegroundServerCloseFailure[] = [];
      if (server.status === 'rejected') failures.push(Object.freeze({ error: server.reason, resource: 'server' }));
      if (coordinator.status === 'rejected') failures.push(Object.freeze({ error: coordinator.reason, resource: 'coordinator' }));
      return Object.freeze(failures);
    });
    return this.#releasePromise;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requestHostMatches(request, this.url)) {
      throw requestError(diagnostic('AB8008', 'Request host is not this foreground server.', 400));
    }
    const pathname = new URL(request.url ?? '/', this.url).pathname;
    const method = request.method ?? 'GET';
    if (await this.#mcpAppRoutes.handle(request, response)) return;
    if (await this.#mcpSessionRoutes.handle(request, response)) return;
    if (await this.#hookPlaygroundRoutes.handle(request, response)) return;
    const route = skillRoute(request.url);
    if (route !== undefined) return this.#serveSkill(route, response, method);
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
      if (!isJsonRequest(request)) {
        return responseDiagnostic(response, diagnostic('AB8009', 'Request body must use application/json.', 415));
      }
      await this.#coordinator.rebuild(manualInvalidation(await readBody(request), this.#now));
      return responseJson(response, { status: this.#coordinator.status() });
    }
    if (pathname === '/api/project/events') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return this.#streamEvents(request, response);
    }
    return this.#serveAsset(request, response, method);
  }

  async #serveSkill(route: SkillRoute, response: ServerResponse, method: string): Promise<void> {
    const service = this.#skillDocuments;
    if (service === undefined) {
      return responseDiagnostic(response, diagnostic('AB8011', 'Skill workbench service is not available.', 404));
    }
    const resource = route.kind === 'source-resource' || route.kind === 'generated-resource';
    if (method !== 'GET' && (!resource || method !== 'HEAD')) {
      return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    try {
      if (route.kind === 'source-tree') return responseJson(response, await service.sourceTree());
      if (route.kind === 'source-document') return responseJson(response, { document: await service.source(route.skillId) });
      if (route.kind === 'generated-tree') {
        return responseJson(response, await service.generatedTree(route.epochId, route.target));
      }
      if (route.kind === 'generated-document') {
        return responseJson(response, { document: await service.generated(route.epochId, route.target, route.skillId) });
      }
      const value = route.kind === 'source-resource'
        ? await service.sourceResource(route.skillId, route.resource)
        : await service.generatedResource(route.epochId, route.target, route.skillId, route.resource);
      const headers: Record<string, string> = {
        'content-length': String(value.body.byteLength),
        'content-type': value.contentType,
        'x-content-type-options': 'nosniff',
      };
      if (value.contentDisposition === 'attachment') {
        headers['content-disposition'] = attachmentHeader(value.relativePath);
      }
      response.writeHead(200, headers);
      response.end(method === 'HEAD' ? undefined : value.body);
    } catch (error) {
      if (error instanceof SkillDocumentError) {
        return responseDiagnostic(response, diagnostic(error.code, error.message, 404));
      }
      throw error;
    }
  }

  #assertSessionBootstrapOrigin(request: IncomingMessage): void {
    const origin = singleHeader(request.headers.origin);
    if (origin === this.url) return;
    if (origin === undefined && singleHeader(request.headers['sec-fetch-site']) === 'same-origin') return;
    throw requestError(diagnostic('AB8003', 'Request origin is not this foreground server.', 403));
  }

  #assertMutationSession(request: IncomingMessage): void {
    const origin = singleHeader(request.headers.origin);
    if (origin !== this.url && (origin !== undefined || singleHeader(request.headers['sec-fetch-site']) !== 'same-origin')) {
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
    response.flushHeaders();
    let backpressured = false;
    let closed = false;
    let bufferedBytes = 0;
    let queuedBytes = 0;
    const queued: QueuedSseFrame[] = [];
    const stream = { subscription: undefined as ProjectEventSubscription | undefined };
    const unsubscribe = () => {
      stream.subscription?.unsubscribe();
      if (stream.subscription !== undefined) this.#streamSubscriptions.delete(stream.subscription);
      bufferedBytes = 0;
      queued.length = 0;
      queuedBytes = 0;
    };
    const closeStream = () => {
      closed = true;
      unsubscribe();
    };
    const closeSlowStream = () => {
      closeStream();
      response.destroy();
    };
    const drain = () => {
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
    const deliver = (frame: string) => {
      if (closed || response.writableEnded || response.destroyed) return;
      const bytes = Buffer.byteLength(frame);
      if (!backpressured) {
        if (!response.write(frame)) {
          backpressured = true;
          bufferedBytes = bytes;
          response.once('drain', drain);
        }
        return;
      }
      if (bufferedBytes + queuedBytes + bytes > sseQueueByteLimit) {
        closeSlowStream();
        return;
      }
      queued.push({ bytes, frame });
      queuedBytes += bytes;
    };
    const subscription = this.#eventHub.subscribe({ afterSequence: sequence }, (event) => {
      deliver(eventFrame(event));
    });
    stream.subscription = subscription;
    if (closed || request.destroyed || response.destroyed) {
      closeStream();
      return;
    }
    this.#streamSubscriptions.add(subscription);
    request.once('close', closeStream);
    response.once('close', closeStream);
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
