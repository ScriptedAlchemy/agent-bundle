import { createServer, type Server } from 'node:http';

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
  const parentOrigin = new URL(location.hash.slice(1), location.href).origin;
  const reserved = new Set(['sandbox/ready', 'sandbox/resource-ready', 'sandbox/initialized', 'sandbox/close']);
  const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const post = (message) => parent.postMessage(message, parentOrigin);
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== parentOrigin || byteLength(event.data) > 262144) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.type !== 'sandbox/resource-ready') return;
    if (typeof message.html !== 'string' || message.html.length > 262144) return;
    app.allow = typeof message.allow === 'string' ? message.allow : '';
    app.srcdoc = message.html;
    post({ type: 'sandbox/resource-ready' });
  });
  app.addEventListener('load', () => post({ type: 'sandbox/initialized' }));
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
  readonly hostOrigin: string;
  readonly port?: number;
}

export interface McpAppSandboxProxy {
  readonly origin: string;
  readonly url: string;
  close(): Promise<void>;
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

const closeServer = async (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

export const createMcpAppSandboxProxy = async (
  options: CreateMcpAppSandboxProxyOptions,
): Promise<McpAppSandboxProxy> => {
  const hostOrigin = originOf(options.hostOrigin);
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
  const port = await listen(server, options.port ?? 0);
  const origin = `http://127.0.0.1:${port}`;
  if (origin === hostOrigin) {
    await closeServer(server);
    throw new Error('MCP App sandbox proxy must use a different origin from its host');
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    origin,
    url: `${origin}/`,
    close: () => {
      closePromise ??= closeServer(server);
      return closePromise;
    },
  });
};
