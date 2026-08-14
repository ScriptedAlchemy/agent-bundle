import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

const PROXY_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'self'",
  'img-src data:',
  "script-src 'unsafe-inline'",
].join('; ');

const PROXY_PERMISSIONS_POLICY = 'camera=(), clipboard-write=(), geolocation=(), microphone=()';

const SHELL = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP App sandbox</title>
<style>html,body,iframe{border:0;height:100%;margin:0;width:100%}</style>
<iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
  'use strict';
  const app = document.getElementById('app');
  const reserved = new Set(['sandbox/ready', 'sandbox/resource-ready', 'sandbox/initialized', 'sandbox/close']);
  const maxMessageBytes = 262144;
  let lifecycle = 'created';
  let parentOrigin = 'null';
  try { parentOrigin = new URL(decodeURIComponent(location.hash.slice(1))).origin; } catch {}
  const byteLength = (value) => {
    try { const serialized = JSON.stringify(value); return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : Infinity; } catch { return Infinity; }
  };
  const message = (value) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.type === 'string' && byteLength(value) <= maxMessageBytes;
  const escapeHtmlAttribute = (value) => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  const post = (value) => parent.postMessage(value, parentOrigin);
  window.addEventListener('message', (event) => {
    if (event.source === parent) {
      if (event.origin !== parentOrigin || !message(event.data)) return;
      const inbound = event.data;
      if (inbound.type === 'sandbox/resource-ready') {
        if (lifecycle !== 'ready' || typeof inbound.html !== 'string' || typeof inbound.contentSecurityPolicy !== 'string' || typeof inbound.allow !== 'string') return;
        if (inbound.html.length > maxMessageBytes || inbound.contentSecurityPolicy.length > 16384) return;
        lifecycle = 'resource-pending';
        app.allow = inbound.allow;
        app.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + escapeHtmlAttribute(inbound.contentSecurityPolicy) + '">' + inbound.html;
        post({ type: 'sandbox/resource-ready' });
        return;
      }
      if (inbound.type === 'sandbox/close') {
        lifecycle = 'closed';
        app.removeAttribute('srcdoc');
        return;
      }
      if (reserved.has(inbound.type) || lifecycle !== 'initialized') return;
      app.contentWindow.postMessage(inbound, '*');
      return;
    }
    if (event.source !== app.contentWindow || event.origin !== 'null' || lifecycle !== 'initialized' || !message(event.data)) return;
    if (reserved.has(event.data.type)) return;
    post(event.data);
  });
  app.addEventListener('load', () => {
    if (lifecycle !== 'resource-pending') return;
    lifecycle = 'initialized';
    post({ type: 'sandbox/initialized' });
  });
  lifecycle = 'ready';
  post({ type: 'sandbox/ready' });
</script>`;

export interface McpAppSandboxCsp {
  readonly baseUriDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
}

export interface McpAppSandboxPermissions {
  readonly camera?: boolean;
  readonly clipboardWrite?: boolean;
  readonly geolocation?: boolean;
  readonly microphone?: boolean;
}

export interface McpAppSandboxDeclaration {
  readonly csp?: McpAppSandboxCsp;
  readonly permissions?: McpAppSandboxPermissions;
}

export interface McpAppSandboxPolicy {
  readonly contentSecurityPolicy: string;
  readonly permissionsPolicy: string;
}

export interface CreateMcpAppSandboxProxyOptions {
  readonly closeTimeoutMs?: number;
  readonly hostOrigin: string;
  readonly port?: number;
}

export interface McpAppSandboxProxy {
  readonly origin: string;
  readonly url: string;
  close(): Promise<void>;
}

export interface CreateMcpAppSandboxFrameOptions {
  readonly hostOrigin: string;
  readonly proxyOrigin: string;
}

export interface McpAppSandboxFrame {
  readonly referrerPolicy: 'no-referrer';
  readonly sandbox: 'allow-scripts allow-same-origin';
  readonly src: string;
  readonly targetOrigin: string;
}

export const MCP_APP_SANDBOX_NOTIFICATION_TYPES = Object.freeze([
  'sandbox/ready',
  'sandbox/resource-ready',
  'sandbox/initialized',
  'sandbox/close',
] as const);

type McpAppSandboxNotificationType = typeof MCP_APP_SANDBOX_NOTIFICATION_TYPES[number];

export type McpAppSandboxLifecycle = 'created' | 'ready' | 'resource-pending' | 'resource-ready' | 'initialized' | 'closed';

export interface McpAppSandboxMessage {
  readonly type: string;
  readonly [key: string]: unknown;
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
  readonly declaration?: McpAppSandboxDeclaration;
  readonly html: string;
}

export interface CreateMcpAppSandboxBridgeOptions {
  readonly maxMessageBytes?: number;
  readonly maxQueuedMessages?: number;
  readonly onMessage?: (message: McpAppSandboxMessage) => void;
  readonly proxyOrigin: string;
  readonly proxyWindow: McpAppSandboxWindow;
}

export interface McpAppSandboxBridge {
  readonly lifecycle: McpAppSandboxLifecycle;
  close(): void;
  provideResource(resource: McpAppSandboxResource): boolean;
  receive(event: McpAppSandboxMessageEvent): boolean;
  send(message: McpAppSandboxMessage): boolean;
}

const cspSources = (sources: readonly string[] | undefined): readonly string[] => {
  const accepted = new Set<string>();
  for (const source of sources ?? []) {
    try {
      const parsed = new URL(source);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) continue;
      if (parsed.pathname !== '/') continue;
      accepted.add(parsed.origin);
    } catch {
      // Untrusted declarations never become policy sources.
    }
  }
  return [...accepted];
};

const sourceList = (sources: readonly string[], fallback: string): string => sources.length > 0 ? sources.join(' ') : fallback;

const withInline = (sources: readonly string[]): string => ['\'unsafe-inline\'', ...sources].join(' ');

const permissionPolicy = (permissions: McpAppSandboxPermissions | undefined): string => {
  const entries: readonly [keyof McpAppSandboxPermissions, string][] = [
    ['camera', 'camera'],
    ['clipboardWrite', 'clipboard-write'],
    ['geolocation', 'geolocation'],
    ['microphone', 'microphone'],
  ];
  return entries.map(([key, directive]) => `${directive}=(${permissions?.[key] === true ? 'self' : ''})`).join(', ');
};

const iframeAllow = (permissions: McpAppSandboxPermissions | undefined): string => {
  const entries: readonly [keyof McpAppSandboxPermissions, string][] = [
    ['camera', 'camera'],
    ['clipboardWrite', 'clipboard-write'],
    ['geolocation', 'geolocation'],
    ['microphone', 'microphone'],
  ];
  return entries.filter(([key]) => permissions?.[key] === true).map(([, directive]) => directive).join('; ');
};

export const deriveMcpAppSandboxPolicy = (declaration: McpAppSandboxDeclaration): McpAppSandboxPolicy => {
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
    permissionsPolicy: permissionPolicy(declaration.permissions),
  };
};

const originOf = (value: string): string => {
  const parsed = new URL(value);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new TypeError('hostOrigin must be an HTTP(S) origin without credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('hostOrigin must not include a path, query, or fragment');
  }
  return parsed.origin;
};

export const createMcpAppSandboxFrame = (
  options: CreateMcpAppSandboxFrameOptions,
): McpAppSandboxFrame => {
  const hostOrigin = originOf(options.hostOrigin);
  const proxyOrigin = originOf(options.proxyOrigin);
  if (hostOrigin === proxyOrigin) {
    throw new Error('MCP App sandbox frame must use a different origin from its host');
  }
  const proxyUrl = new URL(proxyOrigin);
  if (proxyUrl.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(proxyUrl.hostname)) {
    throw new TypeError('MCP App sandbox frame must target a loopback HTTP proxy');
  }
  return Object.freeze({
    referrerPolicy: 'no-referrer',
    sandbox: 'allow-scripts allow-same-origin',
    src: `${proxyOrigin}/#${encodeURIComponent(hostOrigin)}`,
    targetOrigin: proxyOrigin,
  });
};

const maximum = (value: number | undefined, fallback: number, name: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
};

const messageSize = (message: unknown): number | undefined => {
  try {
    const serialized = JSON.stringify(message);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized) : undefined;
  } catch {
    return undefined;
  }
};

const isMessage = (value: unknown, maxMessageBytes: number): value is McpAppSandboxMessage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  const size = messageSize(value);
  return typeof type === 'string' && type.length > 0 && size !== undefined && size <= maxMessageBytes;
};

const isReservedNotification = (type: string): type is McpAppSandboxNotificationType => (
  MCP_APP_SANDBOX_NOTIFICATION_TYPES.some((notification) => notification === type)
);

export const createMcpAppSandboxBridge = (
  options: CreateMcpAppSandboxBridgeOptions,
): McpAppSandboxBridge => {
  const proxyOrigin = originOf(options.proxyOrigin);
  const maxMessageBytes = maximum(options.maxMessageBytes, 256 * 1024, 'maxMessageBytes');
  const maxQueuedMessages = maximum(options.maxQueuedMessages, 32, 'maxQueuedMessages');
  const queuedMessages: McpAppSandboxMessage[] = [];
  let lifecycle: McpAppSandboxLifecycle = 'created';

  const post = (message: McpAppSandboxMessage): void => {
    options.proxyWindow.postMessage(message, proxyOrigin);
  };

  const flush = (): void => {
    while (queuedMessages.length > 0) {
      const message = queuedMessages.shift();
      if (message) post(message);
    }
  };

  const close = (): void => {
    if (lifecycle === 'closed') return;
    lifecycle = 'closed';
    queuedMessages.length = 0;
    post({ type: 'sandbox/close' });
  };

  return Object.freeze({
    get lifecycle(): McpAppSandboxLifecycle {
      return lifecycle;
    },
    close,
    provideResource(resource: McpAppSandboxResource): boolean {
      if (lifecycle !== 'ready' || typeof resource.html !== 'string' || resource.html.length > maxMessageBytes) return false;
      const policy = deriveMcpAppSandboxPolicy(resource.declaration ?? {});
      const message: McpAppSandboxMessage = {
        allow: iframeAllow(resource.declaration?.permissions),
        contentSecurityPolicy: policy.contentSecurityPolicy,
        html: resource.html,
        type: 'sandbox/resource-ready',
      };
      if (!isMessage(message, maxMessageBytes)) return false;
      lifecycle = 'resource-pending';
      post(message);
      return true;
    },
    receive(event: McpAppSandboxMessageEvent): boolean {
      if (lifecycle === 'closed' || event.source !== options.proxyWindow || event.origin !== proxyOrigin) return false;
      if (!isMessage(event.data, maxMessageBytes)) return false;
      const message = event.data;
      switch (message.type) {
        case 'sandbox/ready':
          if (lifecycle !== 'created') return false;
          lifecycle = 'ready';
          return true;
        case 'sandbox/resource-ready':
          if (lifecycle !== 'resource-pending') return false;
          lifecycle = 'resource-ready';
          return true;
        case 'sandbox/initialized':
          if (lifecycle !== 'resource-ready') return false;
          lifecycle = 'initialized';
          flush();
          return true;
        case 'sandbox/close':
          lifecycle = 'closed';
          queuedMessages.length = 0;
          return true;
        default:
          if (isReservedNotification(message.type) || lifecycle !== 'initialized') return false;
          options.onMessage?.(message);
          return true;
      }
    },
    send(message: McpAppSandboxMessage): boolean {
      if (lifecycle === 'closed' || !isMessage(message, maxMessageBytes) || isReservedNotification(message.type)) return false;
      if (lifecycle === 'initialized') {
        post(message);
        return true;
      }
      if ((lifecycle !== 'resource-pending' && lifecycle !== 'resource-ready') || queuedMessages.length >= maxQueuedMessages) {
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
  const settle = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (error) reject(error);
    else resolve();
  };
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, timeoutMs);
  server.close((error) => settle(error ?? undefined));
});

export const createMcpAppSandboxProxy = async (
  options: CreateMcpAppSandboxProxyOptions,
): Promise<McpAppSandboxProxy> => {
  const hostOrigin = originOf(options.hostOrigin);
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
      'permissions-policy': PROXY_PERMISSIONS_POLICY,
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
    url: `${origin}/`,
    close: () => {
      closePromise ??= closeServer(server, sockets, closeTimeoutMs);
      return closePromise;
    },
  });
};
