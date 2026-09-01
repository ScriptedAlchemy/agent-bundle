import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The shape every dev-server route group under test exposes to the harness. */
export interface RouteHandler {
  /** Route groups whose evidence is already in memory answer synchronously. */
  handle(request: IncomingMessage, response: ServerResponse): boolean | Promise<boolean>;
  close(): void | Promise<void>;
}

export interface StartedRoutes<Routes extends RouteHandler> {
  readonly close: () => Promise<void>;
  readonly routes: Routes;
  readonly url: string;
}

/**
 * How the harness treats `routes.close()` inside `StartedRoutes.close`:
 * - 'started': begin `routes.close()` without awaiting it, then close the server.
 * - 'awaited': await `routes.close()` before closing the server.
 * - 'server-only': close only the HTTP server; the test owns route shutdown.
 */
export type RouteCloseMode = 'awaited' | 'server-only' | 'started';

export interface StartRoutesOptions {
  readonly closeMode?: RouteCloseMode;
}

export const routeError = (code: string, message: string, status: number): Error & {
  readonly code: string;
  readonly message: string;
  readonly status: number;
} => Object.assign(new Error(message), { code, message, status });

/** The foreground guard used by routes that check both the origin and the session token. */
export const authorize = (request: IncomingMessage): void => {
  if (request.headers.origin !== 'http://127.0.0.1:4567') {
    throw routeError('AB8003', 'Request origin is not this foreground server.', 403);
  }
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

/** The foreground guard used by routes that check only the session token. */
export const authorizeSession = (request: IncomingMessage): void => {
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

export const originHeaders = (): Readonly<Record<string, string>> => ({
  origin: 'http://127.0.0.1:4567',
  'x-agent-bundle-session': 'test-session-token',
});

export const sessionHeaders = (): Readonly<Record<string, string>> => ({
  'x-agent-bundle-session': 'test-session-token',
});

export const startRoutes = async <Routes extends RouteHandler>(
  routes: Routes,
  options: StartRoutesOptions = {},
): Promise<StartedRoutes<Routes>> => {
  const closeMode = options.closeMode ?? 'started';
  const server = createServer((request, response) => {
    void (async () => routes.handle(request, response))().then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const diagnostic = error as Partial<{ code: string; diagnostics: unknown; message: string; status: number }>;
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.writeHead(diagnostic.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        diagnostic: {
          code: diagnostic.code ?? 'AB8007',
          message: diagnostic.message ?? 'Request could not be completed.',
        },
        ...(diagnostic.diagnostics === undefined ? {} : { diagnostics: diagnostic.diagnostics }),
      }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => {
      switch (closeMode) {
        case 'started':
          void routes.close();
          break;
        case 'awaited':
          await routes.close();
          break;
        case 'server-only':
          break;
        default: {
          const exhausted: never = closeMode;
          throw new Error(`Unhandled route close mode: ${String(exhausted)}`);
        }
      }
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
    },
    routes,
    url: `http://127.0.0.1:${address.port}`,
  });
};
