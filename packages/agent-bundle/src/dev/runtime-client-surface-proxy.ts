import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as requestUpstream,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

import type {
  DevRuntimeClientSurfaceEndpoint,
  DevRuntimeClientSurfaceProxyBinding,
} from './runtime-provider.ts';

const appAssetLimit = 4 * 1024 * 1024;
const headerLimit = 16 * 1024;
const webSocketBufferLimit = 2 * 1024 * 1024;
const webSocketMessageLimit = 1_048_576;
const loopbackHosts = new Set(['127.0.0.1', '::1']);

export interface RuntimeClientSurfaceConnectionEvent {
  readonly connectionCount: number;
  readonly surfaceId: string;
  readonly type: 'connected' | 'disconnected';
}

interface ValidatedEndpoint {
  readonly entryPath: string;
  readonly httpOrigin: URL;
  readonly httpPathPrefixes: readonly string[];
  readonly surfaceId: string;
  readonly webSocketOrigin: URL;
}

const invalidEndpoint = (message: string): never => {
  throw new TypeError(`Runtime client surface endpoint must use ${message}.`);
};

const response = (target: ServerResponse, status: number): void => {
  target.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
  target.end(status === 403 ? 'Forbidden' : status === 413 ? 'Payload Too Large' : 'Not Found');
};

const rawHeaderBytes = (request: IncomingMessage): number => request.rawHeaders.reduce(
  (size, value) => size + Buffer.byteLength(value),
  0,
);

const hasBody = (request: IncomingMessage): boolean => {
  const length = request.headers['content-length'];
  if (typeof length === 'string' && length !== '0') return true;
  return request.headers['transfer-encoding'] !== undefined;
};

const rawDataBytes = (data: WebSocket.RawData): number => typeof data === 'string'
  ? Buffer.byteLength(data)
  : Array.isArray(data)
    ? data.reduce((total, part) => total + part.byteLength, 0)
    : data.byteLength;

const decodedPath = (path: string, allowRoot = false): string => {
  if (!path.startsWith('/')) invalidEndpoint('an absolute entry path');
  if (path === '/') {
    if (allowRoot) return '/';
    invalidEndpoint('a non-root entry path');
  }
  const segments = path.slice(1).split('/').map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return invalidEndpoint('a percent-decodable path');
    }
    if (
      decoded.length === 0 || decoded === '.' || decoded === '..' ||
      decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
    ) invalidEndpoint('a containment-safe path');
    return decoded;
  });
  return `/${segments.join('/')}`;
};

const prefix = (value: string): string => {
  const path = decodedPath(value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value, true);
  return path === '/' ? '/' : `${path}/`;
};

const matchesPrefix = (path: string, prefixes: readonly string[]): boolean => prefixes.some((candidate) =>
  candidate === '/' || path === candidate.slice(0, -1) || path.startsWith(candidate));

const origin = (value: string, protocol: 'http:' | 'ws:'): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidEndpoint(`a literal loopback ${protocol === 'http:' ? 'HTTP' : 'WebSocket'} origin`);
  }
  if (
    parsed.protocol !== protocol || !loopbackHosts.has(parsed.hostname) ||
    parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== '/' ||
    parsed.search.length > 0 || parsed.hash.length > 0
  ) {
    return invalidEndpoint(`a literal loopback ${protocol === 'http:' ? 'HTTP' : 'WebSocket'} origin`);
  }
  return parsed;
};

const endpoint = (input: DevRuntimeClientSurfaceEndpoint): ValidatedEndpoint => {
  if (typeof input.surfaceId !== 'string' || input.surfaceId.length === 0 || input.surfaceId.includes('\0')) {
    invalidEndpoint('a nonempty surface id');
  }
  const httpOrigin = origin(input.httpOrigin, 'http:');
  const webSocketOrigin = origin(input.webSocketOrigin, 'ws:');
  if (httpOrigin.hostname !== webSocketOrigin.hostname || httpOrigin.port !== webSocketOrigin.port) {
    invalidEndpoint('matching host and port for HTTP and WebSocket origins');
  }
  if (!Array.isArray(input.httpPathPrefixes) || input.httpPathPrefixes.length === 0) {
    invalidEndpoint('at least one declared HTTP path prefix');
  }
  const httpPathPrefixes = Object.freeze([...new Set(input.httpPathPrefixes.map(prefix))]);
  const entryPath = decodedPath(input.entryPath);
  if (!matchesPrefix(entryPath, httpPathPrefixes)) invalidEndpoint('an entry path within a declared HTTP prefix');
  if (input.webSocketPath !== '/rsbuild-hmr') invalidEndpoint('the exact /rsbuild-hmr WebSocket path');
  return Object.freeze({ entryPath, httpOrigin, httpPathPrefixes, surfaceId: input.surfaceId, webSocketOrigin });
};

const cookieValue = (request: IncomingMessage, name: string): string | undefined => {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const value of header.split(';')) {
    const [key, ...rest] = value.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
};

const copyResponseHeaders = (headers: IncomingMessage['headers']): Record<string, string | readonly string[]> => {
  const copied: Record<string, string | readonly string[]> = {};
  const allowed = new Set(['cache-control', 'content-encoding', 'content-language', 'content-type', 'etag', 'last-modified', 'vary']);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && allowed.has(name.toLowerCase())) copied[name] = value;
  }
  return copied;
};

const responseChunks = async (source: IncomingMessage): Promise<Uint8Array> => new Promise((resolvePromise, rejectPromise) => {
  const declared = source.headers['content-length'];
  if (typeof declared === 'string' && (!/^\d+$/u.test(declared) || Number(declared) > appAssetLimit)) {
    source.resume();
    rejectPromise(new RangeError('Runtime client asset exceeds the allowed size.'));
    return;
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > appAssetLimit) {
      source.destroy();
      return;
    }
    chunks.push(chunk);
  });
  source.once('end', () => bytes > appAssetLimit
    ? rejectPromise(new RangeError('Runtime client asset exceeds the allowed size.'))
    : resolvePromise(Buffer.concat(chunks)));
  source.once('error', rejectPromise);
});

const sameOriginRedirect = (location: string, upstream: URL): string | undefined => {
  let redirect: URL;
  try {
    redirect = new URL(location, upstream);
  } catch {
    return undefined;
  }
  if (redirect.origin !== upstream.origin) return undefined;
  try {
    return `${decodedPath(redirect.pathname, true)}${redirect.search}`;
  } catch {
    return undefined;
  }
};

const closeServer = (server: Server): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  server.close((error) => error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
    ? resolvePromise()
    : rejectPromise(error));
});

/**
 * Server-only proxy construction for a trusted runtime compiler endpoint. Its
 * browser binding has no upstream selection, middleware, or arbitrary path API.
 */
export class RuntimeClientSurfaceProxy {
  static async open(
    input: DevRuntimeClientSurfaceEndpoint,
    listener: (event: RuntimeClientSurfaceConnectionEvent) => void,
  ): Promise<DevRuntimeClientSurfaceProxyBinding> {
    const trusted = endpoint(input);
    const bootstrapCapability = randomBytes(32).toString('base64url');
    const sessionCapability = randomBytes(32).toString('base64url');
    const bootstrapPath = `/__agent_bundle_runtime/bootstrap/${bootstrapCapability}`;
    const cookieName = 'agent_bundle_runtime';
    const sockets = new Set<Socket>();
    const webSockets = new Set<WebSocket>();
    const webSocketServer = new WebSocketServer({ maxPayload: webSocketMessageLimit, noServer: true });
    let activeConnections = 0;
    let bootstrapUsed = false;
    let closed = false;
    let closePromise: Promise<void> | undefined;

    const emit = (type: RuntimeClientSurfaceConnectionEvent['type']): void => {
      try {
        listener(Object.freeze({ connectionCount: activeConnections, surfaceId: trusted.surfaceId, type }));
      } catch {
        // Browser HMR availability must not depend on an observability listener.
      }
    };

    const isAuthenticated = (request: IncomingMessage): boolean =>
      cookieValue(request, cookieName) === sessionCapability;

    const server = createServer((request, target) => {
      void (async () => {
        const requestUrl = new URL(request.url ?? '/', 'http://proxy.invalid');
        if (rawHeaderBytes(request) > headerLimit || hasBody(request)) {
          request.resume();
          response(target, 413);
          return;
        }
        if (requestUrl.pathname === bootstrapPath) {
          if (request.method !== 'GET' || requestUrl.search.length > 0 || bootstrapUsed || closed) {
            response(target, 403);
            return;
          }
          bootstrapUsed = true;
          target.writeHead(302, {
            location: trusted.entryPath,
            'set-cookie': `${cookieName}=${sessionCapability}; HttpOnly; SameSite=Strict; Path=/`,
            'x-content-type-options': 'nosniff',
          });
          target.end();
          return;
        }
        if (!isAuthenticated(request)) {
          response(target, 403);
          return;
        }
        if (closed || (request.method !== 'GET' && request.method !== 'HEAD')) {
          response(target, closed ? 404 : 405);
          return;
        }
        let path: string;
        try {
          path = decodedPath(requestUrl.pathname, true);
        } catch {
          response(target, 404);
          return;
        }
        if (!matchesPrefix(path, trusted.httpPathPrefixes)) {
          response(target, 404);
          return;
        }
        const upstreamRequest = requestUpstream({
          headers: {
            ...(typeof request.headers.accept === 'string' ? { accept: request.headers.accept } : {}),
            ...(typeof request.headers['accept-encoding'] === 'string' ? { 'accept-encoding': request.headers['accept-encoding'] } : {}),
          },
          host: trusted.httpOrigin.hostname,
          method: request.method,
          path: `${path}${requestUrl.search}`,
          port: trusted.httpOrigin.port,
          protocol: trusted.httpOrigin.protocol,
        }, async (upstream) => {
          const status = upstream.statusCode ?? 502;
          const headers = copyResponseHeaders(upstream.headers);
          if (status >= 300 && status < 400 && typeof upstream.headers.location === 'string') {
            const location = sameOriginRedirect(upstream.headers.location, trusted.httpOrigin);
            upstream.resume();
            if (location === undefined) {
              response(target, 502);
              return;
            }
            target.writeHead(status, { location, 'x-content-type-options': 'nosniff' });
            target.end();
            return;
          }
          try {
            const body = request.method === 'HEAD' ? new Uint8Array() : await responseChunks(upstream);
            target.writeHead(status, {
              ...headers,
              'content-length': String(body.byteLength),
              'x-content-type-options': 'nosniff',
            });
            target.end(request.method === 'HEAD' ? undefined : body);
          } catch {
            if (!target.headersSent) response(target, 413);
            else target.destroy();
          }
        });
        upstreamRequest.once('error', () => {
          if (!target.headersSent) response(target, 502);
          else target.destroy();
        });
        upstreamRequest.end();
      })().catch(() => response(target, 502));
    });

    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    server.on('upgrade', (request, socket, head) => {
      const reject = (status: 403 | 404 | 413): void => {
        socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 413 ? 'Payload Too Large' : 'Not Found'}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      if (closed || rawHeaderBytes(request) > headerLimit) return reject(closed ? 404 : 413);
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url ?? '/', 'http://proxy.invalid');
      } catch {
        return reject(404);
      }
      if (!isAuthenticated(request)) return reject(403);
      if (requestUrl.pathname !== '/rsbuild-hmr') return reject(404);
      const requestedProtocols = typeof request.headers['sec-websocket-protocol'] === 'string'
        ? request.headers['sec-websocket-protocol'].split(',').map((protocol) => protocol.trim()).filter(Boolean)
        : [];
      webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
        const upstreamUrl = `${trusted.webSocketOrigin.origin}/rsbuild-hmr${requestUrl.search}`;
        const upstream = new WebSocket(upstreamUrl, requestedProtocols.length > 0 ? requestedProtocols : undefined, {
          maxPayload: webSocketMessageLimit,
        });
        webSockets.add(downstream);
        webSockets.add(upstream);
        let announced = false;
        let pairClosed = false;
        let pendingDownstreamBytes = 0;
        const pendingDownstream: Array<Readonly<{ readonly data: WebSocket.RawData; readonly isBinary: boolean }>> = [];
        const closePair = (): void => {
          if (pairClosed) return;
          pairClosed = true;
          if (announced) {
            activeConnections -= 1;
            emit('disconnected');
          }
          webSockets.delete(downstream);
          webSockets.delete(upstream);
          if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.terminate();
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
        };
        const overBackpressure = (): boolean => downstream.bufferedAmount > webSocketBufferLimit || upstream.bufferedAmount > webSocketBufferLimit;
        const forward = (destination: WebSocket, data: WebSocket.RawData, isBinary: boolean): void => {
          if (pairClosed || destination.readyState !== WebSocket.OPEN) return;
          destination.send(data, { binary: isBinary }, () => {
            if (overBackpressure()) closePair();
          });
          if (overBackpressure()) closePair();
        };
        upstream.once('open', () => {
          if (pairClosed) return;
          announced = true;
          activeConnections += 1;
          emit('connected');
          for (const pending of pendingDownstream.splice(0)) forward(upstream, pending.data, pending.isBinary);
          pendingDownstreamBytes = 0;
        });
        downstream.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.CONNECTING) {
            pendingDownstreamBytes += rawDataBytes(data);
            if (pendingDownstreamBytes > webSocketMessageLimit) {
              closePair();
              return;
            }
            pendingDownstream.push(Object.freeze({ data, isBinary }));
            return;
          }
          forward(upstream, data, isBinary);
        });
        upstream.on('message', (data, isBinary) => forward(downstream, data, isBinary));
        downstream.once('close', closePair);
        upstream.once('close', closePair);
        downstream.once('error', closePair);
        upstream.once('error', closePair);
      });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const fail = (error: Error) => {
        server.off('listening', succeed);
        rejectPromise(error);
      };
      const succeed = () => {
        server.off('error', fail);
        resolvePromise();
      };
      server.once('error', fail);
      server.once('listening', succeed);
      server.listen({ host: '127.0.0.1', port: 0 });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await closeServer(server);
      throw new Error('Runtime client proxy did not report a TCP address.');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const close = async (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const socket of webSockets) socket.terminate();
        for (const socket of sockets) socket.destroy();
        webSocketServer.close();
        await closeServer(server);
      })();
      return closePromise;
    };
    return Object.freeze({
      bootstrapUrl: `${origin}${bootstrapPath}`,
      close,
      origin,
      surfaceId: trusted.surfaceId,
      webSocketPath: '/rsbuild-hmr',
    });
  }
}
