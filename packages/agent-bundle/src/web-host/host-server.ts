import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { isErrno } from '../core/errors.ts';
import { diagnostic, isRequestDiagnostic, requestError, responseDiagnostic, singleHeader } from '../dev/http.ts';
import type { McpAppProfileId } from '../dev/mcp-app-profile-descriptors.ts';
import { McpAppBindingService, type McpAppToolDefinition } from '../dev/mcp-apps/mcp-app-binding-service.ts';
import type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';
import {
  mcpAppPreviewHost,
  mcpAppPreviewHostInfo,
  openInBrowser,
  type OpenBrowser,
} from '../dev/mcp-apps/mcp-app-preview-host.ts';
import { McpAppPreviewService } from '../dev/mcp-apps/mcp-app-preview-service.ts';
import { McpAppRoutes } from '../dev/mcp-apps/mcp-app-routes.ts';
import { createMcpAppSandboxProxy } from '../dev/mcp-apps/mcp-app-sandbox.ts';
import { renderWebHostPage, WEB_HOST_TOKEN_HEADER, webHostContentSecurityPolicy } from './page.ts';
import type { AppSelection } from './select-app.ts';
import { sessionAuthorityFor, type StdioAppSession } from './session.ts';

/** Plain Node host bundled into generated executables; the caller retains ownership of the session (#564). */
export interface StartWebHostOptions {
  readonly autoApprove: readonly McpAppConsentCapability[];
  readonly open: boolean;
  readonly openBrowser?: OpenBrowser;
  readonly pageScript: string;
  readonly port: number;
  readonly profile: McpAppProfileId;
  readonly selection: AppSelection;
  readonly session: StdioAppSession;
  readonly title: string;
}

export interface WebHost {
  readonly closed: Promise<void>;
  readonly resourceUri: string;
  readonly sandboxOrigin: string;
  readonly server: string;
  readonly tool: string;
  readonly url: string;
  close(): Promise<void>;
}

const closeTimeoutMs = 1_000;

const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const validPort = (value: number | undefined): number => {
  const port = value ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError('MCP App host port must be a TCP port number.');
  return port;
};

export const validProfile = (value: McpAppProfileId | undefined): McpAppProfileId => {
  const profile = value ?? 'portable';
  if (profile !== 'portable' && profile !== 'claude' && profile !== 'chatgpt') {
    throw new RangeError(`Unsupported MCP App profile ${JSON.stringify(String(profile))}.`);
  }
  return profile;
};

const listen = async (server: Server, port: number): Promise<number> => new Promise((resolvePort, reject) => {
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port }, () => {
    server.off('error', reject);
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('The MCP App host did not receive a TCP address.'));
      return;
    }
    resolvePort(address.port);
  });
});

const closeServer = async (server: Server, sockets: ReadonlySet<Socket>): Promise<void> => new Promise((resolveClose, reject) => {
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, closeTimeoutMs);
  server.close((error) => {
    clearTimeout(deadline);
    if (error !== undefined && !isErrno(error, 'ERR_SERVER_NOT_RUNNING')) reject(error);
    else resolveClose();
  });
  for (const socket of sockets) socket.destroy();
});

const requestOriginIsHost = (request: IncomingMessage, url: string): boolean => {
  const origin = singleHeader(request.headers.origin);
  if (origin !== undefined) return origin === url;
  return singleHeader(request.headers['sec-fetch-site']) === 'same-origin';
};

const hostHeaderIsLoopback = (request: IncomingMessage, port: number): boolean => {
  const host = singleHeader(request.headers.host);
  if (host === undefined) return false;
  const separator = host.lastIndexOf(':');
  if (separator === -1) return false;
  return loopbackHosts.has(host.slice(0, separator)) && host.slice(separator + 1) === String(port);
};

/**
 * Acquired resources, released newest first. Each release swallows its own
 * failure so a later one still runs, as the finalizers of the former Effect
 * scope did; `run()` is idempotent.
 */
const releaseStack = (): Readonly<{ push(release: () => Promise<void> | void): void; run(): Promise<void> }> => {
  const releases: (() => Promise<void> | void)[] = [];
  let running: Promise<void> | undefined;
  return Object.freeze({
    push: (release: () => Promise<void> | void) => { releases.push(release); },
    run: () => {
      running ??= (async () => {
        for (const release of releases.splice(0).reverse()) {
          try {
            await release();
          } catch {
            // Best-effort teardown: the next resource still gets released.
          }
        }
      })();
      return running;
    },
  });
};

export const startWebHost = async (options: StartWebHostOptions): Promise<WebHost> => {
  const port = validPort(options.port);
  const profile = validProfile(options.profile);
  const { selection, session } = options;
  const autoApprove = Object.freeze([...options.autoApprove]);
  const openBrowser = options.openBrowser ?? openInBrowser;
  const token = randomBytes(32).toString('base64url');
  const releases = releaseStack();
  try {
    const sockets = new Set<Socket>();
    // The listener is installed after the routes exist; a request racing the
    // wiring is refused rather than served without authorization.
    const dispatch: { current?: (request: IncomingMessage, response: ServerResponse) => Promise<void> } = {};
    const server = createServer((request, response) => {
      const handler = dispatch.current;
      if (handler === undefined) {
        responseDiagnostic(response, diagnostic('AB8022', 'MCP App host is not ready.', 503));
        return;
      }
      void handler(request, response).catch((error: unknown) => {
        if (isRequestDiagnostic(error)) {
          responseDiagnostic(response, error);
          return;
        }
        responseDiagnostic(response, diagnostic('AB8023', 'MCP App operation could not be completed.', 502));
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const boundPort = await listen(server, port);
    releases.push(() => closeServer(server, sockets));
    const url = `http://127.0.0.1:${String(boundPort)}`;
    const sandbox = await createMcpAppSandboxProxy({ hostOrigin: url });
    releases.push(() => sandbox.close());
    const bindings = new McpAppBindingService({ sessionAuthority: sessionAuthorityFor(session) });
    const previews = new McpAppPreviewService({
      bindingAuthority: bindings,
      host: mcpAppPreviewHost(openBrowser),
      hostInfo: mcpAppPreviewHostInfo,
      hostOrigin: url,
      sandboxProxy: sandbox,
      toolAuthority: {
        resolveTool: async (sessionId, toolName): Promise<McpAppToolDefinition> => {
          if (sessionId !== session.sessionId || toolName !== selection.tool.name) {
            throw new Error(`Unknown MCP App tool ${JSON.stringify(toolName)}.`);
          }
          return selection.tool;
        },
      },
    });
    releases.push(() => previews.closeAll());
    const authorize = (request: IncomingMessage): void => {
      if (!hostHeaderIsLoopback(request, boundPort) || !requestOriginIsHost(request, url)) {
        throw requestError(diagnostic('AB8003', 'Request origin is not this MCP App host.', 403));
      }
      if (singleHeader(request.headers[WEB_HOST_TOKEN_HEADER]) !== token) {
        throw requestError(diagnostic('AB8004', 'A valid MCP App host token is required.', 403));
      }
    };
    // The page binds the opening call this host already made instead of
    // posting the result back: a large result would otherwise exceed the
    // request-body bound and drop the App to the fallback panel (#562).
    const openingCall = (sessionId: string, toolName: string) =>
      sessionId === session.sessionId && toolName === selection.tool.name
        ? Object.freeze({ input: selection.input, result: selection.result })
        : undefined;
    const routes = new McpAppRoutes({ authorize, openingCall, service: previews });
    releases.push(() => { routes.close(); });
    const page = renderWebHostPage({
      script: options.pageScript,
      seed: {
        autoApprove,
        input: selection.input,
        previewProfile: profile,
        result: selection.result,
        sessionId: session.sessionId,
        title: options.title,
        token,
        tokenHeader: WEB_HOST_TOKEN_HEADER,
        toolName: selection.tool.name,
      },
    });
    const contentSecurityPolicy = webHostContentSecurityPolicy(sandbox.origin);
    dispatch.current = async (request, response) => {
      if (!hostHeaderIsLoopback(request, boundPort)) {
        throw requestError(diagnostic('AB8003', 'Request origin is not this MCP App host.', 403));
      }
      if (await routes.handle(request, response)) return;
      const pathname = new URL(request.url ?? '/', url).pathname;
      if (pathname !== '/' && pathname !== '/index.html') {
        responseDiagnostic(response, diagnostic('AB8020', 'Not found.', 404));
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-security-policy': contentSecurityPolicy,
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : page);
    };
    if (options.open) await openBrowser(`${url}/`);
    return Object.freeze({
      close: () => releases.run(),
      closed: session.closed,
      resourceUri: selection.resourceUri,
      sandboxOrigin: sandbox.origin,
      server: selection.server,
      tool: selection.tool.name,
      url: `${url}/`,
    });
  } catch (error) {
    await releases.run();
    throw error;
  }
};
