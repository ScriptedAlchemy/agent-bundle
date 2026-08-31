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
import {
  runtimeAppFiniteOrdinaryJsonByteLength,
  runtimeAppMessageLimits,
} from './runtime-app-message-limits.ts';

const appAssetLimit = 4 * 1024 * 1024;
const headerLimit = 16 * 1024;
const upstreamRequestTimeout = 15_000;
const loopbackHosts = new Set(['127.0.0.1', '::1']);
/**
 * Proxy-owned browser push channel. The proxy authors both ends: its server
 * broadcasts only the owned reload frame below, and the bootstrap shell it
 * serves is the only intended client. Rsbuild's WebSocket envelope is never
 * dialed, parsed, or forwarded here, so Rsbuild upgrades cannot silently
 * change Runtime App reload behavior.
 */
export const runtimeClientSurfaceReloadChannelPath = '/__agent_bundle_runtime/reload';
const reloadMessageKind = 'runtime-app-reload';
const reloadMessageLimit = 256;
const endpointKeys = Object.freeze([
  'entryPath',
  'httpOrigin',
  'httpPathPrefixes',
  'subscribeReload',
  'surfaceId',
] as const);
const contentPolicyKeys = Object.freeze(['contentSecurityPolicy'] as const);

/** Trusted server-only policy for the one opaque child installed by this proxy. */
export interface RuntimeClientSurfaceContentPolicy {
  readonly contentSecurityPolicy: string;
}

/** Direct fixture access receives the same strict no-network child policy. */
export const strictRuntimeClientSurfaceContentPolicy: RuntimeClientSurfaceContentPolicy = Object.freeze({
  contentSecurityPolicy: "default-src 'none'; base-uri 'self'; connect-src 'none'; frame-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
});

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
  readonly subscribeReload: (listener: () => void) => () => void;
  readonly surfaceId: string;
}

const invalidEndpoint = (message: string): never => {
  throw new TypeError(`Runtime client surface endpoint must use ${message}.`);
};

const invalidContentPolicy = (message: string): never => {
  throw new TypeError(`Runtime client surface content policy must use ${message}.`);
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

const contentSecurityPolicy = (input: RuntimeClientSurfaceContentPolicy): string => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidContentPolicy('a plain policy record');
  const prototype = (() => {
    try {
      return Object.getPrototypeOf(input);
    } catch {
      return invalidContentPolicy('a plain policy record');
    }
  })();
  if (prototype !== Object.prototype && prototype !== null) invalidContentPolicy('a plain policy record');
  const keys = (() => {
    try {
      return Reflect.ownKeys(input);
    } catch {
      return invalidContentPolicy('an inspectable policy record');
    }
  })();
  if (keys.length !== contentPolicyKeys.length || keys.some((key) => typeof key !== 'string' || !contentPolicyKeys.includes(key as typeof contentPolicyKeys[number]))) {
    invalidContentPolicy('exactly the declared policy field');
  }
  const descriptor: PropertyDescriptor = (() => {
    try {
      const current = Object.getOwnPropertyDescriptor(input, 'contentSecurityPolicy');
      if (current === undefined || !Object.hasOwn(current, 'value')) {
        return invalidContentPolicy('an own data contentSecurityPolicy field');
      }
      return current;
    } catch {
      return invalidContentPolicy('an own data contentSecurityPolicy field');
    }
  })();
  const value = descriptor.value;
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.includes('\0')) {
    invalidContentPolicy('a bounded nonempty contentSecurityPolicy string');
  }
  return value;
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

const escapedHtmlAttribute = (value: string): string => value.replace(/[&<>"']/gu, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[character] as string);

/**
 * The same-origin outer document is the sole relay. The compiler App is never
 * granted that origin: it runs in this document's one opaque nested iframe.
 */
const runtimeProxyShell = (
  entryPath: string,
  entryDocument: string,
  hostOrigin: string,
  childContentSecurityPolicy: string,
  initialReloadGeneration: number,
): string => `<!doctype html>
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
  const childContentSecurityPolicy = ${escapedScriptValue(childContentSecurityPolicy)};
  const reloadChannelPath = ${escapedScriptValue(runtimeClientSurfaceReloadChannelPath)};
  const reloadMessageKind = ${escapedScriptValue(reloadMessageKind)};
  const maxAppToHostMessageBytes = ${String(runtimeAppMessageLimits.appToHostBytes)};
  const maxHostToAppMessageBytes = ${String(runtimeAppMessageLimits.hostToAppBytes)};
  const maxReloadMessageBytes = ${String(reloadMessageLimit)};
  const maxEntryBytes = ${String(appAssetLimit)};
  const finiteOrdinaryJsonByteLength = ${runtimeAppFiniteOrdinaryJsonByteLength.toString()};
  const allowedKeys = new Set(['error', 'id', 'jsonrpc', 'method', 'params', 'result']);
  let initializeId;
  let lifecycle = 'created';
  const maxPendingHostMessages = 32;
  let pendingHostMessages = [];
  let reloadSocket;
  let reloadReconnectAttempts = 0;
  let reloadReconnectTimer;
  let reloadGeneration = ${String(initialReloadGeneration)};
  let appliedReloadGeneration = reloadGeneration;
  let refreshController;
  let refreshGeneration = 0;
  let refreshing = false;
  const childDocument = (entry) => '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + ${escapedScriptValue(escapedHtmlAttribute(childContentSecurityPolicy))} + '">' + entry;
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const validId = (value) => value === null || (typeof value === 'string' && value.length <= 256) || (typeof value === 'number' && Number.isFinite(value));
  const isRpc = (value, maximumBytes) => {
    if (finiteOrdinaryJsonByteLength(value, { maximumBytes }) === undefined || !isRecord(value) || value.jsonrpc !== '2.0') return false;
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
    if (lifecycle === 'closed' || typeof entry !== 'string' || new TextEncoder().encode(entry).byteLength > maxEntryBytes) return false;
    initializeId = undefined;
    lifecycle = 'created';
    app.srcdoc = childDocument(entry);
    return true;
  };
  const refreshEntry = async () => {
    if (refreshing || lifecycle === 'closed') return;
    refreshing = true;
    const generation = refreshGeneration;
    // The requested generation this attempt can prove: the fetch starts now,
    // so its response reflects at least every reload announced before now.
    const target = reloadGeneration;
    const controller = new AbortController();
    refreshController = controller;
    const current = () => lifecycle !== 'closed' && refreshGeneration === generation && refreshController === controller && !controller.signal.aborted;
    try {
      const response = await fetch(entryPath, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!current()) return;
      const length = response.headers.get('content-length');
      if (!response.ok || (length !== null && (!/^\\d+$/.test(length) || Number(length) > maxEntryBytes))) return;
      const type = response.headers.get('content-type') || '';
      if (!/^text\\/html(?:;|$)/i.test(type)) return;
      const entry = await response.text();
      if (!current()) return;
      if (installEntry(entry)) appliedReloadGeneration = target;
    } catch {
      // A failed reload must leave the already-admitted child and its bridge
      // intact. appliedReloadGeneration stays behind, so the next frame — the
      // server replays its current generation on every reconnect — retries.
    } finally {
      if (refreshController === controller) {
        refreshController = undefined;
        refreshing = false;
        // A reload announced while this refresh was in flight must not be
        // swallowed: this fetch may predate that compilation's output, so
        // run another refresh for the newer generation.
        if (lifecycle !== 'closed' && reloadGeneration > target) void refreshEntry();
      }
    }
  };
  installEntry(initialEntry);
  const reconnectReloadChannel = () => {
    if (lifecycle === 'closed' || reloadReconnectTimer !== undefined) return;
    const delay = Math.min(1_000, 100 * (2 ** Math.min(reloadReconnectAttempts, 4)));
    reloadReconnectAttempts += 1;
    reloadReconnectTimer = setTimeout(() => {
      reloadReconnectTimer = undefined;
      openReloadChannel();
    }, delay);
  };
  const openReloadChannel = () => {
    if (lifecycle === 'closed' || reloadSocket !== undefined) return;
    let socket;
    try { socket = new WebSocket(new URL(reloadChannelPath, location.origin).href); }
    catch { reconnectReloadChannel(); return; }
    reloadSocket = socket;
    const reconnect = () => {
      if (reloadSocket !== socket) return;
      reloadSocket = undefined;
      try { socket.close(); } catch {}
      reconnectReloadChannel();
    };
    socket.addEventListener('open', () => {
      if (reloadSocket !== socket || lifecycle === 'closed') return;
      reloadReconnectAttempts = 0;
    });
    socket.addEventListener('message', (event) => {
      if (reloadSocket !== socket || lifecycle === 'closed' || typeof event.data !== 'string' || event.data.length > maxReloadMessageBytes) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      // The proxy authors this channel end to end; only its owned reload kind
      // exists. Generations already applied stay inert, so duplicate frames
      // and the on-connect resync are idempotent, while a generation newer
      // than the last applied one always drives a refresh — catching up on
      // reloads that fired while the socket was down (the server replays its
      // current generation on every accepted connection), that arrived while
      // a refresh fetch was already in flight, or whose refresh failed.
      if (!isRecord(message) || message.kind !== reloadMessageKind) return;
      const generation = message.generation;
      if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= appliedReloadGeneration) return;
      if (generation > reloadGeneration) reloadGeneration = generation;
      void refreshEntry();
    });
    socket.addEventListener('close', reconnect);
    socket.addEventListener('error', reconnect);
  };
  openReloadChannel();
  addEventListener('message', (event) => {
    if (lifecycle === 'closed') return;
    if (event.source === parent) {
      if (event.origin !== hostOrigin || !isRpc(event.data, maxHostToAppMessageBytes)) return;
      if (lifecycle === 'initializing' && isInitializeResponse(event.data)) {
        lifecycle = 'initialize-responded';
        post(app.contentWindow, '*', event.data, event.ports, maxHostToAppMessageBytes);
        return;
      }
      if (lifecycle !== 'initialized') {
        // Queue instead of dropping: a host request relayed into the
        // handshake window (ui/resource-teardown racing the App's
        // ui/notifications/initialized) would otherwise vanish, its sender
        // would burn its bounded grace waiting for an answer that can never
        // arrive, and the acknowledgement evidence would be lost forever.
        // The queue also survives an HMR entry reload, so a request sent to
        // the retiring App instance is answered by its replacement.
        if (pendingHostMessages.length < maxPendingHostMessages) pendingHostMessages.push({ data: event.data, ports: event.ports });
        return;
      }
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
      for (const pending of pendingHostMessages.splice(0)) post(app.contentWindow, '*', pending.data, pending.ports, maxHostToAppMessageBytes);
      return;
    }
    if (lifecycle === 'initialized') post(parent, hostOrigin, event.data, event.ports, maxAppToHostMessageBytes);
  });
  addEventListener('pagehide', () => {
    lifecycle = 'closed';
    pendingHostMessages = [];
    if (reloadReconnectTimer !== undefined) clearTimeout(reloadReconnectTimer);
    reloadReconnectTimer = undefined;
    const activeReloadSocket = reloadSocket;
    reloadSocket = undefined;
    try { activeReloadSocket?.close(); } catch {}
    const activeRefresh = refreshController;
    refreshController = undefined;
    try { activeRefresh?.abort(); } catch {}
    refreshGeneration += 1;
  }, { once: true });
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

const origin = (value: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidEndpoint('a literal loopback HTTP origin');
  }
  if (
    parsed.protocol !== 'http:' || !loopbackHosts.has(literalHost(parsed)) ||
    parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== '/' ||
    parsed.search.length > 0 || parsed.hash.length > 0
  ) {
    return invalidEndpoint('a literal loopback HTTP origin');
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
  const httpOrigin = origin(endpointValue(input, 'httpOrigin'));
  const host = literalHost(httpOrigin);
  const declaredPrefixes = endpointValue(input, 'httpPathPrefixes');
  if (!Array.isArray(declaredPrefixes) || declaredPrefixes.length === 0) {
    invalidEndpoint('at least one declared HTTP path prefix');
  }
  const httpPathPrefixes = Object.freeze([...new Set(declaredPrefixes.map(prefix))]);
  const entryPath = canonicalPath(endpointValue(input, 'entryPath')).normalized;
  if (!matchesPrefix(entryPath, httpPathPrefixes)) invalidEndpoint('an entry path within a declared HTTP prefix');
  const subscribeReload = endpointValue(input, 'subscribeReload');
  if (typeof subscribeReload !== 'function') invalidEndpoint('a provider-owned subscribeReload function');
  return Object.freeze({
    entryPath,
    host,
    httpOrigin,
    httpPathPrefixes,
    subscribeReload: subscribeReload as ValidatedEndpoint['subscribeReload'],
    surfaceId,
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
    policy: RuntimeClientSurfaceContentPolicy = strictRuntimeClientSurfaceContentPolicy,
  ): Promise<DevRuntimeClientSurfaceProxyBinding> {
    const trusted = endpoint(input);
    const trustedHostOrigin = canonicalHostOrigin(hostOrigin);
    const trustedContentSecurityPolicy = contentSecurityPolicy(policy);
    const bootstrapCapability = randomBytes(32).toString('base64url');
    const sessionCapability = randomBytes(32).toString('base64url');
    const bootstrapPath = `/__agent_bundle_runtime/bootstrap/${bootstrapCapability}`;
    const cookieName = `__Host-agent_bundle_runtime_${randomBytes(16).toString('hex')}`;
    const sockets = new Set<Socket>();
    const upstreamAgent = new Agent({ keepAlive: true });
    const upstreamAborts = new Set<() => void>();
    const upstreamRequests = new Set<ClientRequest>();
    const upstreamSockets = new Set<Socket>();
    const reloadClients = new Set<WebSocket>();
    const webSocketServer = new WebSocketServer({ maxPayload: reloadMessageLimit, noServer: true });
    let activeConnections = 0;
    let bootstrapUsed = false;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    let reloadGeneration = 0;
    let reloadSubscription: (() => void) | undefined;

    const emit = (type: RuntimeClientSurfaceConnectionEvent['type']): void => {
      try {
        listener(Object.freeze({ connectionCount: activeConnections, surfaceId: trusted.surfaceId, type }));
      } catch {
        // Browser HMR availability must not depend on an observability listener.
      }
    };

    const sendReloadFrame = (client: WebSocket): void => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(JSON.stringify({ generation: reloadGeneration, kind: reloadMessageKind }));
      } catch {
        client.terminate();
      }
    };

    const announceReload = (): void => {
      if (closed) return;
      reloadGeneration += 1;
      for (const client of [...reloadClients]) sendReloadFrame(client);
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
          // Capture the reload generation before fetching the entry: a reload
          // that lands during the fetch then reads as newer than this shell's
          // baseline, so the channel refreshes it instead of losing it.
          const bootstrapReloadGeneration = reloadGeneration;
          let entryDocument: string;
          try {
            entryDocument = await readCurrentEntry();
          } catch {
            response(target, 502);
            return;
          }
          const headers: Record<string, string> = {
            'cache-control': 'no-store',
            'content-security-policy': runtimeProxyContentSecurityPolicy(trustedHostOrigin),
            'content-type': 'text/html; charset=utf-8',
            'x-content-type-options': 'nosniff',
          };
          headers['set-cookie'] = `${cookieName}=${sessionCapability}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/`;
          target.writeHead(200, headers);
          target.end(runtimeProxyShell(
            trusted.entryPath,
            entryDocument,
            trustedHostOrigin,
            trustedContentSecurityPolicy,
            bootstrapReloadGeneration,
          ));
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
      if (requestUrl.pathname !== runtimeClientSurfaceReloadChannelPath) return reject(404);
      if (requestUrl.search.length > 0) return reject(404);
      if (request.headers.origin !== proxyOrigin) return reject(403);
      // The owned channel has no subprotocols; a client negotiating one is
      // not the relay shell this proxy installed.
      if (request.headers['sec-websocket-protocol'] !== undefined) return reject(403);
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        if (closed) {
          client.terminate();
          return;
        }
        reloadClients.add(client);
        activeConnections += 1;
        emit('connected');
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          reloadClients.delete(client);
          activeConnections -= 1;
          emit('disconnected');
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.terminate();
        };
        // The channel is strictly proxy-to-relay; an inbound frame means the
        // peer is not the installed shell, so release it instead of buffering.
        client.on('message', release);
        client.once('close', release);
        client.once('error', release);
        // Replay the current generation so a shell that reconnects after a
        // missed reload refreshes instead of silently staying stale.
        sendReloadFrame(client);
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
        try {
          reloadSubscription?.();
        } catch {
          // Provider-side unsubscribe failures must not block browser release.
        }
        reloadSubscription = undefined;
        for (const abort of [...upstreamAborts]) abort();
        for (const request of upstreamRequests) request.destroy();
        upstreamAgent.destroy();
        for (const socket of upstreamSockets) socket.destroy();
        for (const socket of reloadClients) socket.terminate();
        for (const socket of sockets) socket.destroy();
        webSocketServer.close();
        await closeServer(server);
      })();
      return closePromise;
    };
    try {
      const subscription = trusted.subscribeReload(announceReload);
      if (typeof subscription !== 'function') {
        throw new TypeError('Runtime client surface endpoint must return a reload unsubscriber.');
      }
      reloadSubscription = subscription;
    } catch (error) {
      await close();
      throw error;
    }
    return Object.freeze({
      bootstrapUrl: `${proxyOrigin}${bootstrapPath}`,
      close,
      origin: proxyOrigin,
      surfaceId: trusted.surfaceId,
    });
  }
}
