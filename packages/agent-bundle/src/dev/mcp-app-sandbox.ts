import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

const JSON_RPC_VERSION = '2.0';
const SANDBOX_NOTIFICATION_PREFIX = 'ui/notifications/sandbox-';
const PROXY_READY_METHOD = 'ui/notifications/sandbox-proxy-ready';
const RESOURCE_READY_METHOD = 'ui/notifications/sandbox-resource-ready';
const INITIALIZED_METHOD = 'ui/notifications/initialized';
const INITIALIZE_METHOD = 'ui/initialize';
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUED_MESSAGES = 32;
const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024;

const PROXY_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'self'",
  'img-src data:',
  "script-src 'unsafe-inline'",
].join('; ');

const SHELL = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP App sandbox</title>
<style>html,body,iframe{border:0;height:100%;margin:0;width:100%}</style>
<iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
  'use strict';
  const proxyReadyMethod = '${PROXY_READY_METHOD}';
  const resourceReadyMethod = '${RESOURCE_READY_METHOD}';
  const initializedMethod = '${INITIALIZED_METHOD}';
  const initializeMethod = '${INITIALIZE_METHOD}';
  const app = document.getElementById('app');
  let configuration;
  try {
    const candidate = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    const host = new URL(candidate.hostOrigin);
    if (host.origin !== candidate.hostOrigin || !Number.isSafeInteger(candidate.maxMessageBytes) || candidate.maxMessageBytes <= 0) throw new Error('invalid sandbox configuration');
    configuration = { hostOrigin: host.origin, maxMessageBytes: candidate.maxMessageBytes };
  } catch {}
  if (configuration) {
    const maxMessageBytes = configuration.maxMessageBytes;
    let lifecycle = 'created';
    let initializeId;
    const byteLength = (value) => {
      try { const serialized = JSON.stringify(value); return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : Infinity; } catch { return Infinity; }
    };
    const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const isRpc = (value) => isRecord(value) && value.jsonrpc === '${JSON_RPC_VERSION}' && byteLength(value) <= maxMessageBytes && (typeof value.method === 'string' || Object.hasOwn(value, 'id'));
    const isNotification = (value, method) => isRpc(value) && value.method === method && !Object.hasOwn(value, 'id');
    const isSandboxMethod = (method) => typeof method === 'string' && method.startsWith('ui/notifications/sandbox-');
    const escapeHtmlAttribute = (value) => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
    const postNotification = (method, params = {}) => parent.postMessage({ jsonrpc: '${JSON_RPC_VERSION}', method, params }, configuration.hostOrigin);
    const postToApp = (value) => { if (app.contentWindow) app.contentWindow.postMessage(value, '*'); };
    const isInitializeResponse = (value) => isRpc(value) && !Object.hasOwn(value, 'method') && Object.hasOwn(value, 'id') && value.id === initializeId && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));
    window.addEventListener('message', (event) => {
      if (event.source === parent) {
        if (event.origin !== configuration.hostOrigin || !isRpc(event.data)) return;
        const message = event.data;
        if (isNotification(message, resourceReadyMethod)) {
          const params = message.params;
          if (lifecycle !== 'proxy-ready' || !isRecord(params) || typeof params.html !== 'string' || typeof params.contentSecurityPolicy !== 'string' || typeof params.allow !== 'string') return;
          if (byteLength(message) > maxMessageBytes || params.contentSecurityPolicy.length > 16384) return;
          lifecycle = 'resource-pending';
          app.allow = params.allow;
          app.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + escapeHtmlAttribute(params.contentSecurityPolicy) + '">' + params.html;
          lifecycle = 'resource-ready';
          postNotification(resourceReadyMethod);
          return;
        }
        if (isSandboxMethod(message.method)) return;
        if (lifecycle === 'initializing' && isInitializeResponse(message)) {
          lifecycle = 'initialize-responded';
          postToApp(message);
          return;
        }
        if (lifecycle === 'initialized') postToApp(message);
        return;
      }
      if (event.source !== app.contentWindow || event.origin !== 'null' || !isRpc(event.data)) return;
      const message = event.data;
      if (message.method === initializeMethod && Object.hasOwn(message, 'id')) {
        if (lifecycle !== 'resource-ready') return;
        lifecycle = 'initializing';
        initializeId = message.id;
        parent.postMessage(message, configuration.hostOrigin);
        return;
      }
      if (isNotification(message, initializedMethod)) {
        if (lifecycle !== 'initialize-responded') return;
        lifecycle = 'initialized';
        parent.postMessage(message, configuration.hostOrigin);
        return;
      }
      if (isSandboxMethod(message.method) || lifecycle !== 'initialized') return;
      parent.postMessage(message, configuration.hostOrigin);
    });
    lifecycle = 'proxy-ready';
    postNotification(proxyReadyMethod);
  }
</script>`;

export type McpAppSandboxCapability = Readonly<Record<never, never>>;

export interface McpAppSandboxCsp {
  readonly baseUriDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
}

export interface McpAppSandboxPermissions {
  readonly camera?: McpAppSandboxCapability;
  readonly clipboardWrite?: McpAppSandboxCapability;
  readonly geolocation?: McpAppSandboxCapability;
  readonly microphone?: McpAppSandboxCapability;
}

export interface McpAppSandboxDeclaration {
  readonly csp?: McpAppSandboxCsp;
  readonly permissions?: McpAppSandboxPermissions;
}

export interface McpAppSandboxConsent {
  readonly permissions?: McpAppSandboxPermissions;
}

export interface McpAppSandboxPolicy {
  readonly contentSecurityPolicy: string;
  readonly iframeAllow: string;
  readonly permissionsPolicy: string;
}

export interface McpAppSandboxRelay {
  readonly maxMessageBytes: number;
  readonly maxQueuedMessages: number;
}

export interface McpAppSandboxEndpoint {
  readonly origin: string;
  readonly relay: McpAppSandboxRelay;
}

export interface CreateMcpAppSandboxProxyOptions {
  readonly closeTimeoutMs?: number;
  readonly hostOrigin: string;
  readonly maxMessageBytes?: number;
  readonly maxQueuedMessages?: number;
  readonly port?: number;
}

export interface McpAppSandboxProxy extends McpAppSandboxEndpoint {
  readonly url: string;
  close(): Promise<void>;
}

export interface CreateMcpAppSandboxFrameOptions {
  readonly consent?: McpAppSandboxConsent;
  readonly declaration?: McpAppSandboxDeclaration;
  readonly hostOrigin: string;
  readonly proxy: McpAppSandboxEndpoint;
}

export interface McpAppSandboxFrame {
  readonly allow: string;
  readonly policy: McpAppSandboxPolicy;
  readonly referrerPolicy: 'no-referrer';
  readonly relay: McpAppSandboxRelay;
  readonly sandbox: 'allow-scripts allow-same-origin';
  readonly src: string;
  readonly targetOrigin: string;
}

export type McpAppSandboxLifecycle = 'created' | 'proxy-ready' | 'resource-pending' | 'resource-ready' | 'initializing' | 'initialize-responded' | 'initialized' | 'closed';

export type McpAppSandboxRequestId = string | number | null;

export interface McpAppSandboxMessage {
  readonly error?: unknown;
  readonly id?: McpAppSandboxRequestId;
  readonly jsonrpc: '2.0';
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

export interface McpAppSandboxMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export interface McpAppSandboxWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface McpAppSandboxResource {
  readonly html: string;
}

export interface CreateMcpAppSandboxBridgeOptions {
  readonly frame: McpAppSandboxFrame;
  readonly onMessage?: (message: McpAppSandboxMessage) => void;
  readonly proxyWindow: McpAppSandboxWindow;
}

export interface McpAppSandboxBridge {
  readonly lifecycle: McpAppSandboxLifecycle;
  close(): void;
  provideResource(resource: McpAppSandboxResource): boolean;
  receive(event: McpAppSandboxMessageEvent): boolean;
  send(message: McpAppSandboxMessage): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const isCapability = (value: unknown): value is McpAppSandboxCapability => isRecord(value);

const cspSources = (sources: readonly string[] | undefined): readonly string[] => {
  const accepted = new Set<string>();
  for (const source of sources ?? []) {
    try {
      const parsed = new URL(source);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') continue;
      accepted.add(parsed.origin);
    } catch {
      // Untrusted declarations never become policy sources.
    }
  }
  return [...accepted];
};

const sourceList = (sources: readonly string[], fallback: string): string => sources.length > 0 ? sources.join(' ') : fallback;

const withInline = (sources: readonly string[]): string => ['\'unsafe-inline\'', ...sources].join(' ');

const permissionEntries: readonly [keyof McpAppSandboxPermissions, string][] = [
  ['camera', 'camera'],
  ['clipboardWrite', 'clipboard-write'],
  ['geolocation', 'geolocation'],
  ['microphone', 'microphone'],
];

const permitted = (
  declaration: McpAppSandboxPermissions | undefined,
  consent: McpAppSandboxPermissions | undefined,
  key: keyof McpAppSandboxPermissions,
): boolean => isCapability(declaration?.[key]) && isCapability(consent?.[key]);

const permissionPolicy = (declaration: McpAppSandboxPermissions | undefined, consent: McpAppSandboxPermissions | undefined): string => (
  permissionEntries.map(([key, directive]) => `${directive}=(${permitted(declaration, consent, key) ? 'self' : ''})`).join(', ')
);

const iframeAllow = (declaration: McpAppSandboxPermissions | undefined, consent: McpAppSandboxPermissions | undefined): string => (
  permissionEntries.filter(([key]) => permitted(declaration, consent, key)).map(([, directive]) => directive).join('; ')
);

export const deriveMcpAppSandboxPolicy = (
  declaration: McpAppSandboxDeclaration,
  consent: McpAppSandboxConsent = {},
): McpAppSandboxPolicy => {
  const connect = cspSources(declaration.csp?.connectDomains);
  const resources = cspSources(declaration.csp?.resourceDomains);
  const frames = cspSources(declaration.csp?.frameDomains);
  const baseUri = cspSources(declaration.csp?.baseUriDomains);
  return {
    contentSecurityPolicy: [
      "default-src 'none'",
      `base-uri ${sourceList(baseUri, "'none'")}`,
      `connect-src ${sourceList(connect, "'none'")}`,
      `frame-src ${sourceList(frames, "'none'")}`,
      `img-src ${['data:', ...resources].join(' ')}`,
      `media-src ${sourceList(resources, "'none'")}`,
      `font-src ${sourceList(resources, "'none'")}`,
      `style-src ${withInline(resources)}`,
      `script-src ${withInline(resources)}`,
    ].join('; '),
    iframeAllow: iframeAllow(declaration.permissions, consent.permissions),
    permissionsPolicy: permissionPolicy(declaration.permissions, consent.permissions),
  };
};

const originOf = (value: string): string => {
  const parsed = new URL(value);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new TypeError('origin must be an HTTP(S) origin without credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('origin must not include a path, query, or fragment');
  }
  return parsed.origin;
};

const maximum = (value: number | undefined, fallback: number, name: string, maximumValue = Number.MAX_SAFE_INTEGER): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximumValue) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximumValue}`);
  }
  return resolved;
};

const relayOf = (maxMessageBytes: number | undefined, maxQueuedMessages: number | undefined): McpAppSandboxRelay => Object.freeze({
  maxMessageBytes: maximum(maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 'maxMessageBytes', MAX_RELAY_MESSAGE_BYTES),
  maxQueuedMessages: maximum(maxQueuedMessages, DEFAULT_MAX_QUEUED_MESSAGES, 'maxQueuedMessages'),
});

const messageSize = (message: unknown): number | undefined => {
  try {
    const serialized = JSON.stringify(message);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized) : undefined;
  } catch {
    return undefined;
  }
};

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

const isRequestId = (value: unknown): value is McpAppSandboxRequestId => value === null || typeof value === 'string' || typeof value === 'number';

const isMessage = (value: unknown, maxMessageBytes: number): value is McpAppSandboxMessage => {
  if (!isRecord(value) || value.jsonrpc !== JSON_RPC_VERSION) return false;
  const size = messageSize(value);
  if (size === undefined || size > maxMessageBytes) return false;
  const hasMethod = typeof value.method === 'string' && value.method.length > 0;
  const hasId = hasOwn(value, 'id') && isRequestId(value.id);
  return hasMethod || (hasId && (hasOwn(value, 'result') || hasOwn(value, 'error')));
};

const isNotification = (message: McpAppSandboxMessage, method: string): boolean => message.method === method && !hasOwn(message, 'id');

const isSandboxNotification = (message: McpAppSandboxMessage): boolean => typeof message.method === 'string' && message.method.startsWith(SANDBOX_NOTIFICATION_PREFIX);

const isInitializeRequest = (message: McpAppSandboxMessage): message is McpAppSandboxMessage & { readonly id: McpAppSandboxRequestId } => (
  message.method === INITIALIZE_METHOD && hasOwn(message, 'id') && isRequestId(message.id)
);

const isInitializeResponse = (message: McpAppSandboxMessage, id: McpAppSandboxRequestId | undefined): boolean => (
  !hasOwn(message, 'method') && hasOwn(message, 'id') && message.id === id && (hasOwn(message, 'result') || hasOwn(message, 'error'))
);

const notification = (method: string, params: unknown = {}): McpAppSandboxMessage => ({ jsonrpc: JSON_RPC_VERSION, method, params });

export const createMcpAppSandboxFrame = (
  options: CreateMcpAppSandboxFrameOptions,
): McpAppSandboxFrame => {
  const hostOrigin = originOf(options.hostOrigin);
  const proxyOrigin = originOf(options.proxy.origin);
  if (hostOrigin === proxyOrigin) throw new Error('MCP App sandbox frame must use a different origin from its host');
  const proxyUrl = new URL(proxyOrigin);
  if (proxyUrl.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(proxyUrl.hostname)) {
    throw new TypeError('MCP App sandbox frame must target a loopback HTTP proxy');
  }
  const relay = relayOf(options.proxy.relay.maxMessageBytes, options.proxy.relay.maxQueuedMessages);
  const policy = deriveMcpAppSandboxPolicy(options.declaration ?? {}, options.consent);
  const configuration = encodeURIComponent(JSON.stringify({ hostOrigin, maxMessageBytes: relay.maxMessageBytes }));
  return Object.freeze({
    allow: policy.iframeAllow,
    policy,
    referrerPolicy: 'no-referrer',
    relay: options.proxy.relay,
    sandbox: 'allow-scripts allow-same-origin',
    src: `${proxyOrigin}/#${configuration}`,
    targetOrigin: proxyOrigin,
  });
};

export const createMcpAppSandboxBridge = (
  options: CreateMcpAppSandboxBridgeOptions,
): McpAppSandboxBridge => {
  const proxyOrigin = originOf(options.frame.targetOrigin);
  const relay = relayOf(options.frame.relay.maxMessageBytes, options.frame.relay.maxQueuedMessages);
  const queuedMessages: McpAppSandboxMessage[] = [];
  let lifecycle: McpAppSandboxLifecycle = 'created';
  let initializeId: McpAppSandboxRequestId | undefined;

  const post = (message: McpAppSandboxMessage): void => options.proxyWindow.postMessage(message, proxyOrigin);

  const flush = (): void => {
    while (queuedMessages.length > 0) {
      const message = queuedMessages.shift();
      if (message) post(message);
    }
  };

  return Object.freeze({
    get lifecycle(): McpAppSandboxLifecycle {
      return lifecycle;
    },
    close(): void {
      lifecycle = 'closed';
      queuedMessages.length = 0;
      initializeId = undefined;
    },
    provideResource(resource: McpAppSandboxResource): boolean {
      if (lifecycle !== 'proxy-ready' || typeof resource.html !== 'string') return false;
      const message = notification(RESOURCE_READY_METHOD, {
        allow: options.frame.allow,
        contentSecurityPolicy: options.frame.policy.contentSecurityPolicy,
        html: resource.html,
      });
      if (!isMessage(message, relay.maxMessageBytes)) return false;
      lifecycle = 'resource-pending';
      post(message);
      return true;
    },
    receive(event: McpAppSandboxMessageEvent): boolean {
      if (lifecycle === 'closed' || event.source !== options.proxyWindow || event.origin !== proxyOrigin) return false;
      if (!isMessage(event.data, relay.maxMessageBytes)) return false;
      const message = event.data;
      if (isNotification(message, PROXY_READY_METHOD)) {
        if (lifecycle !== 'created') return false;
        lifecycle = 'proxy-ready';
        return true;
      }
      if (isNotification(message, RESOURCE_READY_METHOD)) {
        if (lifecycle !== 'resource-pending') return false;
        lifecycle = 'resource-ready';
        return true;
      }
      if (isNotification(message, INITIALIZED_METHOD)) {
        if (lifecycle !== 'initialize-responded') return false;
        lifecycle = 'initialized';
        flush();
        return true;
      }
      if (isSandboxNotification(message)) return false;
      if (isInitializeRequest(message)) {
        if (lifecycle !== 'resource-ready') return false;
        initializeId = message.id;
        lifecycle = 'initializing';
        options.onMessage?.(message);
        return true;
      }
      if (lifecycle !== 'initialized') return false;
      options.onMessage?.(message);
      return true;
    },
    send(message: McpAppSandboxMessage): boolean {
      if (lifecycle === 'closed' || !isMessage(message, relay.maxMessageBytes) || isSandboxNotification(message)) return false;
      if (lifecycle === 'initializing') {
        if (!isInitializeResponse(message, initializeId)) return false;
        lifecycle = 'initialize-responded';
        post(message);
        return true;
      }
      if (lifecycle === 'initialized') {
        post(message);
        return true;
      }
      if ((lifecycle !== 'resource-pending' && lifecycle !== 'resource-ready') || queuedMessages.length >= relay.maxQueuedMessages) {
        return false;
      }
      queuedMessages.push(message);
      return true;
    },
  });
};

const listen = async (server: Server, port: number): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port }, () => {
    server.off('error', reject);
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('MCP App sandbox proxy did not receive a TCP address'));
      return;
    }
    resolve(address.port);
  });
});

const closeServer = async (server: Server, sockets: ReadonlySet<Socket>, timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
  let settled = false;
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, timeoutMs);
  const settle = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (error) reject(error);
    else resolve();
  };
  server.close((error) => settle(error ?? undefined));
});

export const createMcpAppSandboxProxy = async (
  options: CreateMcpAppSandboxProxyOptions,
): Promise<McpAppSandboxProxy> => {
  const hostOrigin = originOf(options.hostOrigin);
  const relay = relayOf(options.maxMessageBytes, options.maxQueuedMessages);
  const closeTimeoutMs = maximum(options.closeTimeoutMs, 1_000, 'closeTimeoutMs');
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://sandbox.invalid');
    if (request.method !== 'GET' || (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html')) {
      response.writeHead(404, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': PROXY_CONTENT_SECURITY_POLICY,
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    response.end(SHELL);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server, options.port ?? 0);
  const origin = `http://127.0.0.1:${port}`;
  if (origin === hostOrigin) {
    await closeServer(server, sockets, closeTimeoutMs);
    throw new Error('MCP App sandbox proxy must use a different origin from its host');
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    origin,
    relay,
    url: `${origin}/`,
    close: () => {
      closePromise ??= closeServer(server, sockets, closeTimeoutMs);
      return closePromise;
    },
  });
};
