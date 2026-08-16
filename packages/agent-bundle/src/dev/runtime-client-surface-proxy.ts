import { randomBytes } from 'node:crypto';
import {
  Agent,
  type ClientRequest,
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
import { runtimeAppMessageLimits } from './runtime-app-message-limits.ts';

const appAssetLimit = 4 * 1024 * 1024;
const headerLimit = 16 * 1024;
const webSocketBufferLimit = 2 * 1024 * 1024;
const webSocketMessageLimit = 1_048_576;
const pendingWebSocketMessageLimit = 64;
const upstreamHandshakeTimeout = 15_000;
const upstreamRequestTimeout = 15_000;
const loopbackHosts = new Set(['127.0.0.1', '::1']);
const hmrToken = /^[A-Za-z0-9_-]{16,128}$/u;
const endpointKeys = Object.freeze([
  'entryPath',
  'httpOrigin',
  'httpPathPrefixes',
  'surfaceId',
  'webSocketOrigin',
  'webSocketPath',
  'webSocketToken',
] as const);

export interface RuntimeClientSurfaceConnectionEvent {
  readonly connectionCount: number;
  readonly surfaceId: string;
  readonly type: 'connected' | 'disconnected';
}

interface ValidatedEndpoint {
  readonly entryPath: string;
  readonly host: string;
  readonly httpOrigin: URL;
  readonly httpPathPrefixes: readonly string[];
  readonly surfaceId: string;
  readonly webSocketOrigin: URL;
  readonly webSocketToken: string;
}

const invalidEndpoint = (message: string): never => {
  throw new TypeError(`Runtime client surface endpoint must use ${message}.`);
};

const endpointValue = <Key extends (typeof endpointKeys)[number]>(
  input: DevRuntimeClientSurfaceEndpoint,
  key: Key,
): DevRuntimeClientSurfaceEndpoint[Key] => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalidEndpoint(`an own data ${key} field`);
  return descriptor!.value as DevRuntimeClientSurfaceEndpoint[Key];
};

const closedEndpoint = (input: DevRuntimeClientSurfaceEndpoint): void => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidEndpoint('a plain endpoint record');
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== endpointKeys.length || keys.some((key) => typeof key !== 'string' || !endpointKeys.includes(key as (typeof endpointKeys)[number]))
  ) {
    invalidEndpoint('exactly the declared endpoint fields');
  }
};

const response = (target: ServerResponse, status: number): void => {
  if (target.destroyed || target.writableEnded) return;
  target.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
  target.end(status === 403 ? 'Forbidden' : status === 413 ? 'Payload Too Large' : 'Not Found');
};

const runtimeProxyContentSecurityPolicy = (hostOrigin: string): string => [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  `frame-ancestors ${hostOrigin}`,
  "form-action 'none'",
  "frame-src 'self'",
  "img-src 'self' data:",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
].join('; ');

const escapedScriptValue = (value: string): string => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => ({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
})[character] as string);

/**
 * The same-origin outer document is the sole relay. The compiler App is never
 * granted that origin: it runs in this document's one opaque nested iframe.
 */
const runtimeProxyShell = (entryPath: string, entryDocument: string, hostOrigin: string): string => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Runtime App surface</title>
<style>html,body,iframe{border:0;height:100%;margin:0;width:100%}</style>
<iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
  'use strict';
  const app = document.getElementById('app');
  const entryPath = ${escapedScriptValue(entryPath)};
  const initialEntry = ${escapedScriptValue(entryDocument)};
  const hostOrigin = ${escapedScriptValue(hostOrigin)};
  const maxAppToHostMessageBytes = ${String(runtimeAppMessageLimits.appToHostBytes)};
  const maxHostToAppMessageBytes = ${String(runtimeAppMessageLimits.hostToAppBytes)};
  const maxHmrMessageBytes = maxAppToHostMessageBytes;
  const maxEntryBytes = ${String(appAssetLimit)};
  const allowedKeys = new Set(['error', 'id', 'jsonrpc', 'method', 'params', 'result']);
  let initializeId;
  let lifecycle = 'created';
  let initialHmrMessage = true;
  let refreshing = false;
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const byteLength = (value) => {
    try {
      const json = JSON.stringify(value);
      return typeof json === 'string' ? new TextEncoder().encode(json).byteLength : Infinity;
    } catch { return Infinity; }
  };
  const validId = (value) => value === null || (typeof value === 'string' && value.length <= 256) || (typeof value === 'number' && Number.isFinite(value));
  const isRpc = (value, maximumBytes) => {
    if (!isRecord(value) || value.jsonrpc !== '2.0' || byteLength(value) > maximumBytes) return false;
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.some((key) => !allowedKeys.has(key))) return false;
    if (hasOwn(value, 'id') && !validId(value.id)) return false;
    if (hasOwn(value, 'method') && (typeof value.method !== 'string' || value.method.length === 0 || value.method.length > 256)) return false;
    return hasOwn(value, 'method') || hasOwn(value, 'id');
  };
  const isNotification = (value, method, maximumBytes) => isRpc(value, maximumBytes) && value.method === method && !hasOwn(value, 'id');
  const post = (target, targetOrigin, message, ports, maximumBytes) => {
    if (!isRpc(message, maximumBytes) || ports.length > 1) return false;
    try {
      if (ports.length === 0) target.postMessage(message, targetOrigin);
      else target.postMessage(message, targetOrigin, ports);
      return true;
    } catch { return false; }
  };
  const isInitializeResponse = (value) => isRpc(value, maxHostToAppMessageBytes) && !hasOwn(value, 'method') && hasOwn(value, 'id') && value.id === initializeId && (hasOwn(value, 'result') || hasOwn(value, 'error'));
  const installEntry = (entry) => {
    if (typeof entry !== 'string' || new TextEncoder().encode(entry).byteLength > maxEntryBytes) return false;
    initializeId = undefined;
    lifecycle = 'created';
    app.srcdoc = entry;
    return true;
  };
  const refreshEntry = async () => {
    if (refreshing || lifecycle === 'closed') return;
    refreshing = true;
    try {
      const response = await fetch(entryPath, { cache: 'no-store', credentials: 'same-origin' });
      const length = response.headers.get('content-length');
      if (!response.ok || (length !== null && (!/^\\d+$/.test(length) || Number(length) > maxEntryBytes))) return;
      const type = response.headers.get('content-type') || '';
      if (!/^text\\/html(?:;|$)/i.test(type)) return;
      installEntry(await response.text());
    } catch {
      // A failed reload must leave the already-admitted child and its bridge intact.
    } finally { refreshing = false; }
  };
  installEntry(initialEntry);
  const hmr = new WebSocket(new URL('/rsbuild-hmr', location.origin).href);
  hmr.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || event.data.length > maxHmrMessageBytes) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!isRecord(message) || typeof message.type !== 'string') return;
    if (message.type === 'ok') {
      if (initialHmrMessage) { initialHmrMessage = false; return; }
      void refreshEntry();
    } else if (message.type === 'full-reload') void refreshEntry();
  });
  addEventListener('message', (event) => {
    if (lifecycle === 'closed') return;
    if (event.source === parent) {
      if (!isRpc(event.data, maxHostToAppMessageBytes)) return;
      if (lifecycle === 'initializing') {
        if (event.origin !== hostOrigin || !isInitializeResponse(event.data)) return;
        lifecycle = 'initialize-responded';
        post(app.contentWindow, '*', event.data, event.ports, maxHostToAppMessageBytes);
        return;
      }
      if (lifecycle !== 'initialized' || event.origin !== hostOrigin) return;
      post(app.contentWindow, '*', event.data, event.ports, maxHostToAppMessageBytes);
      return;
    }
    if (event.source !== app.contentWindow || event.origin !== 'null' || !isRpc(event.data, maxAppToHostMessageBytes)) return;
    if (lifecycle === 'created' && event.data.method === 'ui/initialize' && hasOwn(event.data, 'id')) {
      initializeId = event.data.id;
      lifecycle = 'initializing';
      post(parent, hostOrigin, event.data, event.ports, maxAppToHostMessageBytes);
      return;
    }
    if (lifecycle === 'initialize-responded' && isNotification(event.data, 'ui/notifications/initialized', maxAppToHostMessageBytes)) {
      lifecycle = 'initialized';
      post(parent, hostOrigin, event.data, event.ports, maxAppToHostMessageBytes);
      return;
    }
    if (lifecycle === 'initialized') post(parent, hostOrigin, event.data, event.ports, maxAppToHostMessageBytes);
  });
  addEventListener('pagehide', () => { lifecycle = 'closed'; hmr.close(); }, { once: true });
</script>`;

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

interface CanonicalPath {
  readonly normalized: string;
  readonly upstream: string;
}

const canonicalPath = (path: string, allowRoot = false): CanonicalPath => {
  if (!path.startsWith('/')) invalidEndpoint('an absolute entry path');
  if (path === '/') {
    if (allowRoot) return Object.freeze({ normalized: '/', upstream: '/' });
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
      decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') ||
      decoded.includes('?') || decoded.includes('#') || decoded.includes('%')
    ) invalidEndpoint('a containment-safe path');
    return decoded;
  });
  return Object.freeze({
    normalized: `/${segments.join('/')}`,
    upstream: `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`,
  });
};

const prefix = (value: string): string => {
  const path = canonicalPath(value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value, true).normalized;
  return path === '/' ? '/' : `${path}/`;
};

const matchesPrefix = (path: string, prefixes: readonly string[]): boolean => prefixes.some((candidate) =>
  candidate === '/' || path === candidate.slice(0, -1) || path.startsWith(candidate));

const literalHost = (value: URL): string => value.hostname.startsWith('[') && value.hostname.endsWith(']')
  ? value.hostname.slice(1, -1)
  : value.hostname;

const origin = (value: string, protocol: 'http:' | 'ws:'): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidEndpoint(`a literal loopback ${protocol === 'http:' ? 'HTTP' : 'WebSocket'} origin`);
  }
  if (
    parsed.protocol !== protocol || !loopbackHosts.has(literalHost(parsed)) ||
    parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== '/' ||
    parsed.search.length > 0 || parsed.hash.length > 0
  ) {
    return invalidEndpoint(`a literal loopback ${protocol === 'http:' ? 'HTTP' : 'WebSocket'} origin`);
  }
  return parsed;
};

const canonicalHostOrigin = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidEndpoint('a canonical foreground HTTP origin');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== value ||
    parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== '/' ||
    parsed.search.length > 0 || parsed.hash.length > 0
  ) {
    return invalidEndpoint('a canonical foreground HTTP origin');
  }
  return parsed.origin;
};

const selfContainedEntry = (body: Uint8Array, contentType: string | undefined): string => {
  if (contentType !== undefined && !/^text\/html(?:;|$)/iu.test(contentType)) {
    throw new TypeError('Runtime client entry must be self-contained HTML.');
  }
  const entry = new TextDecoder('utf-8', { fatal: true }).decode(body);
  // The App compiler explicitly emits inline scripts and styles.  A srcdoc
  // child has an opaque origin, so allowing a linked executable resource here
  // would silently change that compiler contract into a broken surface.
  if (/<(?:base|script)\b[^>]*(?:\bhref|\bsrc)\s*=/iu.test(entry) || /<link\b[^>]*\bhref\s*=/iu.test(entry)) {
    throw new TypeError('Runtime client entry must not require external executable resources.');
  }
  return entry;
};

const endpoint = (input: DevRuntimeClientSurfaceEndpoint): ValidatedEndpoint => {
  closedEndpoint(input);
  const surfaceId = endpointValue(input, 'surfaceId');
  if (typeof surfaceId !== 'string' || surfaceId.length === 0 || surfaceId.includes('\0')) {
    invalidEndpoint('a nonempty surface id');
  }
  const httpOrigin = origin(endpointValue(input, 'httpOrigin'), 'http:');
  const webSocketOrigin = origin(endpointValue(input, 'webSocketOrigin'), 'ws:');
  const host = literalHost(httpOrigin);
  if (host !== literalHost(webSocketOrigin) || httpOrigin.port !== webSocketOrigin.port) {
    invalidEndpoint('matching host and port for HTTP and WebSocket origins');
  }
  const declaredPrefixes = endpointValue(input, 'httpPathPrefixes');
  if (!Array.isArray(declaredPrefixes) || declaredPrefixes.length === 0) {
    invalidEndpoint('at least one declared HTTP path prefix');
  }
  const httpPathPrefixes = Object.freeze([...new Set(declaredPrefixes.map(prefix))]);
  const entryPath = canonicalPath(endpointValue(input, 'entryPath')).normalized;
  if (!matchesPrefix(entryPath, httpPathPrefixes)) invalidEndpoint('an entry path within a declared HTTP prefix');
  if (endpointValue(input, 'webSocketPath') !== '/rsbuild-hmr') invalidEndpoint('the exact /rsbuild-hmr WebSocket path');
  const webSocketToken = endpointValue(input, 'webSocketToken');
  if (typeof webSocketToken !== 'string' || !hmrToken.test(webSocketToken)) {
    invalidEndpoint('a bounded Rsbuild WebSocket token');
  }
  return Object.freeze({
    entryPath,
    host,
    httpOrigin,
    httpPathPrefixes,
    surfaceId,
    webSocketOrigin,
    webSocketToken,
  });
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
    source.destroy();
    rejectPromise(new RangeError('Runtime client asset exceeds the allowed size.'));
    return;
  }
  let bytes = 0;
  let settled = false;
  const chunks: Buffer[] = [];
  const finish = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback();
  };
  const fail = (error: Error): void => finish(() => {
    source.destroy();
    rejectPromise(error);
  });
  const timeout = setTimeout(() => fail(new Error('Runtime client asset timed out.')), 15_000);
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > appAssetLimit) {
      fail(new RangeError('Runtime client asset exceeds the allowed size.'));
      return;
    }
    chunks.push(chunk);
  });
  source.once('end', () => finish(() => resolvePromise(Buffer.concat(chunks))));
  source.once('error', (error) => fail(error));
  source.once('aborted', () => fail(new Error('Runtime client asset was aborted.')));
  source.once('close', () => {
    if (!source.complete) fail(new Error('Runtime client asset closed early.'));
  });
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
    return `${canonicalPath(redirect.pathname, true).upstream}${redirect.search}`;
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
    hostOrigin: string,
  ): Promise<DevRuntimeClientSurfaceProxyBinding> {
    const trusted = endpoint(input);
    const trustedHostOrigin = canonicalHostOrigin(hostOrigin);
    const bootstrapCapability = randomBytes(32).toString('base64url');
    const sessionCapability = randomBytes(32).toString('base64url');
    const bootstrapPath = `/__agent_bundle_runtime/bootstrap/${bootstrapCapability}`;
    const cookieName = `__Host-agent_bundle_runtime_${randomBytes(16).toString('hex')}`;
    const sockets = new Set<Socket>();
    const upstreamAgent = new Agent({ keepAlive: true });
    const upstreamAborts = new Set<() => void>();
    const upstreamRequests = new Set<ClientRequest>();
    const upstreamSockets = new Set<Socket>();
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

    const readCurrentEntry = (): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
      let released = false;
      let receivedResponse = false;
      const release = (): void => {
        if (released) return;
        released = true;
        clearTimeout(deadline);
        upstreamRequests.delete(upstreamRequest);
        upstreamAborts.delete(abort);
      };
      const abort = (): void => {
        release();
        if (!upstreamRequest.destroyed) upstreamRequest.destroy();
      };
      const deadline = setTimeout(() => {
        abort();
        rejectPromise(new Error('Runtime client entry timed out.'));
      }, upstreamRequestTimeout);
      const upstreamRequest = requestUpstream({
        agent: upstreamAgent,
        headers: { accept: 'text/html' },
        host: trusted.host,
        method: 'GET',
        path: trusted.entryPath,
        port: trusted.httpOrigin.port,
        protocol: trusted.httpOrigin.protocol,
      }, async (upstream) => {
        receivedResponse = true;
        try {
          if ((upstream.statusCode ?? 502) !== 200) throw new Error('Runtime client entry was not available.');
          resolvePromise(selfContainedEntry(await responseChunks(upstream), upstream.headers['content-type']));
        } catch (error) {
          if (!upstream.destroyed) upstream.destroy();
          rejectPromise(error);
        } finally {
          release();
        }
      });
      upstreamRequests.add(upstreamRequest);
      upstreamAborts.add(abort);
      upstreamRequest.once('socket', (socket) => {
        upstreamSockets.add(socket);
        socket.once('close', () => upstreamSockets.delete(socket));
      });
      upstreamRequest.once('error', (error) => {
        release();
        if (!receivedResponse) rejectPromise(error);
      });
      upstreamRequest.end();
    });

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
          let entryDocument: string;
          try {
            entryDocument = await readCurrentEntry();
          } catch {
            response(target, 502);
            return;
          }
          target.writeHead(200, {
            'cache-control': 'no-store',
            'content-security-policy': runtimeProxyContentSecurityPolicy(trustedHostOrigin),
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `${cookieName}=${sessionCapability}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/`,
            'x-content-type-options': 'nosniff',
          });
          target.end(runtimeProxyShell(trusted.entryPath, entryDocument, trustedHostOrigin));
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
        let path: CanonicalPath;
        try {
          path = canonicalPath(requestUrl.pathname, true);
        } catch {
          response(target, 404);
          return;
        }
        if (!matchesPrefix(path.normalized, trusted.httpPathPrefixes)) {
          response(target, 404);
          return;
        }
        let released = false;
        let receivedResponse = false;
        let timedOut = false;
        const release = (): void => {
          if (released) return;
          released = true;
          clearTimeout(deadline);
          upstreamRequests.delete(upstreamRequest);
          upstreamAborts.delete(abort);
          target.off('close', abort);
          request.off('aborted', abort);
          request.off('error', abort);
        };
        const abort = (): void => {
          release();
          if (!upstreamRequest.destroyed) upstreamRequest.destroy();
        };
        const deadline = setTimeout(() => {
          timedOut = true;
          response(target, 502);
          abort();
        }, upstreamRequestTimeout);
        const upstreamRequest = requestUpstream({
          agent: upstreamAgent,
          headers: {
            ...(typeof request.headers.accept === 'string' ? { accept: request.headers.accept } : {}),
            ...(typeof request.headers['accept-encoding'] === 'string' ? { 'accept-encoding': request.headers['accept-encoding'] } : {}),
          },
          host: trusted.host,
          method: request.method,
          path: `${path.upstream}${requestUrl.search}`,
          port: trusted.httpOrigin.port,
          protocol: trusted.httpOrigin.protocol,
        }, async (upstream) => {
          receivedResponse = true;
          const destroyResponse = (): void => {
            if (!upstream.destroyed) upstream.destroy();
            if (!upstreamRequest.destroyed) upstreamRequest.destroy();
          };
          const status = upstream.statusCode ?? 502;
          const headers = copyResponseHeaders(upstream.headers);
          if (status >= 300 && status < 400 && typeof upstream.headers.location === 'string') {
            const location = sameOriginRedirect(upstream.headers.location, trusted.httpOrigin);
            destroyResponse();
            release();
            if (location === undefined) {
              response(target, 502);
              return;
            }
            target.writeHead(status, { location, 'x-content-type-options': 'nosniff' });
            target.end();
            return;
          }
          try {
            const body = request.method === 'HEAD'
              ? (destroyResponse(), new Uint8Array())
              : await responseChunks(upstream);
            if (target.destroyed || target.writableEnded) return;
            target.writeHead(status, {
              ...headers,
              'content-length': String(body.byteLength),
              'x-content-type-options': 'nosniff',
            });
            target.end(request.method === 'HEAD' ? undefined : body);
          } catch {
            if (target.destroyed || target.writableEnded) return;
            destroyResponse();
            if (!target.headersSent) response(target, 413);
            else target.destroy();
          } finally {
            release();
          }
        });
        upstreamRequests.add(upstreamRequest);
        upstreamAborts.add(abort);
        upstreamRequest.once('socket', (socket) => {
          upstreamSockets.add(socket);
          socket.once('close', () => upstreamSockets.delete(socket));
        });
        upstreamRequest.once('error', () => {
          release();
          if (timedOut || receivedResponse || target.destroyed || target.writableEnded) return;
          if (!target.headersSent) response(target, 502);
          else target.destroy();
        });
        target.once('close', abort);
        request.once('aborted', abort);
        request.once('error', abort);
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
      if (requestUrl.search.length > 0) return reject(404);
      if (request.headers.origin !== proxyOrigin) return reject(403);
      const requestedProtocols = typeof request.headers['sec-websocket-protocol'] === 'string'
        ? request.headers['sec-websocket-protocol'].split(',').map((protocol) => protocol.trim()).filter(Boolean)
        : [];
      webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
        const upstreamUrl = `${trusted.webSocketOrigin.origin}/rsbuild-hmr?token=${trusted.webSocketToken}`;
        const upstream = new WebSocket(upstreamUrl, requestedProtocols.length > 0 ? requestedProtocols : undefined, {
          handshakeTimeout: upstreamHandshakeTimeout,
          maxPayload: webSocketMessageLimit,
        });
        webSockets.add(downstream);
        webSockets.add(upstream);
        let announced = false;
        let pairClosed = false;
        let pendingDownstreamBytes = 0;
        let pendingDownstreamMessages = 0;
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
          pendingDownstream.length = 0;
          pendingDownstreamBytes = 0;
          pendingDownstreamMessages = 0;
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
          pendingDownstreamMessages = 0;
        });
        downstream.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.CONNECTING) {
            pendingDownstreamBytes += rawDataBytes(data);
            pendingDownstreamMessages += 1;
            if (pendingDownstreamBytes > webSocketMessageLimit || pendingDownstreamMessages > pendingWebSocketMessageLimit) {
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
    const proxyOrigin = `http://127.0.0.1:${address.port}`;
    const close = async (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const abort of [...upstreamAborts]) abort();
        for (const request of upstreamRequests) request.destroy();
        upstreamAgent.destroy();
        for (const socket of upstreamSockets) socket.destroy();
        for (const socket of webSockets) socket.terminate();
        for (const socket of sockets) socket.destroy();
        webSocketServer.close();
        await closeServer(server);
      })();
      return closePromise;
    };
    return Object.freeze({
      bootstrapUrl: `${proxyOrigin}${bootstrapPath}`,
      close,
      origin: proxyOrigin,
      surfaceId: trusted.surfaceId,
      webSocketPath: '/rsbuild-hmr',
    });
  }
}
