import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import { RuntimeMcpRoutes } from '../src/dev/runtime-mcp-routes.ts';
import type { DevRuntimeSession } from '../src/dev/runtime-provider.ts';
import { ProjectEventHub, startForegroundServer } from '../src/dev/index.ts';
import type { ProjectStatus } from '../src/dev/types.ts';

const authorize = (request: IncomingMessage): void => {
  if (request.headers.origin !== 'http://127.0.0.1:4567' || request.headers['x-agent-bundle-session'] !== 'runtime-token') {
    throw Object.assign(new Error('unauthorized'), { code: 'AB8004', status: 403 });
  }
};

it('delegates the fixed manual runtime MCP open route without becoming an App preview control path', async () => {
  const opens: unknown[] = [];
  const runtime = {
    mcpRegistry: {
      open: async (request: unknown) => {
        opens.push(request);
        return Object.freeze({
          execute: async () => { throw new Error('unused'); },
          snapshot: () => Object.freeze({
            binding: Object.freeze({
              definitionDigest: 'definition-a', providerSessionId: 'provider-private', registryRevision: 3, serverDigest: 'server-a', serverName: 'weather',
              sessionId: 'session-a', sessionRevision: 2, stateStoreId: 'state-private', target: 'portable', transportDigest: 'transport-a',
            }),
            connection: Object.freeze({ capabilities: Object.freeze({}), protocolEra: 'modern' as const, protocolVersion: '2026-01-26', server: undefined }),
            state: 'ready' as const,
          }),
          watchClosed: () => Object.freeze({ closed: false, unsubscribe: () => undefined }),
        });
      },
    },
  } as unknown as DevRuntimeSession;
  const routes = new RuntimeMcpRoutes({ authorize, runtime });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const failure = error as Partial<{ readonly code: string; readonly status: number }>;
      response.writeHead(failure.status ?? 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ diagnostic: { code: failure.code ?? 'AB8007' } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime/mcp/sessions`, {
      body: JSON.stringify({ serverName: 'weather', target: 'portable' }),
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4567', 'x-agent-bundle-session': 'runtime-token' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session: { binding: {
      definitionDigest: 'definition-a', providerSessionId: 'provider-private', registryRevision: 3, serverDigest: 'server-a', serverName: 'weather',
      sessionId: 'session-a', sessionRevision: 2, stateStoreId: 'state-private', target: 'portable', transportDigest: 'transport-a',
    }, connection: { capabilities: {}, protocolEra: 'modern', protocolVersion: '2026-01-26' }, state: 'ready' } });
    expect(opens).toEqual([{ serverName: 'weather', target: 'portable' }]);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error)));
  }
});

it('claims manual runtime MCP routes before the generic runtime browser API', async () => {
  let opened = false;
  const runtime = {
    mcpRegistry: {
      open: async () => {
        opened = true;
        return Object.freeze({
          execute: async () => { throw new Error('unused'); },
          snapshot: () => Object.freeze({ binding: Object.freeze({
            definitionDigest: 'definition-a', providerSessionId: 'provider-private', registryRevision: 3, serverDigest: 'server-a', serverName: 'weather',
            sessionId: 'session-a', sessionRevision: 2, stateStoreId: 'state-private', target: 'portable', transportDigest: 'transport-a',
          }), connection: Object.freeze({ capabilities: Object.freeze({}), protocolEra: 'modern' as const, protocolVersion: '2026-01-26', server: undefined }), state: 'ready' as const }),
          watchClosed: () => Object.freeze({ closed: false, unsubscribe: () => undefined }),
        });
      },
    },
  } as unknown as DevRuntimeSession;
  const status: ProjectStatus = Object.freeze({ artifact: Object.freeze({ state: 'missing' }), build: Object.freeze({ state: 'idle' }), source: Object.freeze({ diagnostics: Object.freeze([]), state: 'unknown' }) });
  const server = await startForegroundServer({
    coordinator: Object.freeze({ close: async () => undefined, rebuild: async () => undefined, start: async () => undefined, status: () => status }),
    eventHub: new ProjectEventHub(),
    runtime,
  });
  try {
    const response = await fetch(`${server.url}/api/runtime/mcp/sessions`, {
      body: JSON.stringify({ serverName: 'weather', target: 'portable' }),
      headers: { 'content-type': 'application/json', origin: server.url, 'x-agent-bundle-session': server.sessionToken },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(opened).toBe(true);
  } finally {
    await server.close();
  }
});

it('rejects query-bearing manual runtime MCP routes before authorizing a control operation', async () => {
  const routes = new RuntimeMcpRoutes({
    authorize: () => { throw new Error('query-bearing routes must not authorize'); },
  });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const failure = error as Partial<{ readonly code: string; readonly status: number }>;
      response.writeHead(failure.status ?? 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ diagnostic: { code: failure.code ?? 'AB8007' } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  try {
    for (const path of [
      '/api/runtime/mcp/sessions?probe=1',
      '/api/runtime/mcp/sessions/session-a?probe=1',
      '/api/runtime/mcp/sessions/session-a/restart?probe=1',
      '/api/runtime/mcp/sessions/session-a/rpc?probe=1',
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ diagnostic: { code: 'AB8202' } });
    }
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error)));
  }
});

it('maps manual registry conflicts to 409 and waits for restart invalidation before returning a phase-safe failure', async () => {
  let invalidationsDrained = false;
  const runtime = {
    mcpRegistry: {
      restart: async () => Object.freeze({
        action: 'restart-failed' as const,
        invalidatedBindings: Object.freeze([{ sessionId: 'session-a', sessionRevision: 2 }]),
        registryRevision: 3,
        restartedSessionIds: Object.freeze([]),
        runtimeGenerationId: 'generation-a',
        sequence: 4,
      }),
      session: (sessionId: string) => sessionId === 'session-a' ? Object.freeze({
        execute: async () => { throw Object.assign(new Error('stale'), { code: 'RUNTIME_MCP_REGISTRY_CONFLICT' }); },
        snapshot: () => { throw new Error('unused'); },
        watchClosed: () => Object.freeze({ closed: false, unsubscribe: () => undefined }),
      }) : undefined,
    },
  } as unknown as DevRuntimeSession;
  const routes = new RuntimeMcpRoutes({
    authorize,
    awaitRegistryMutation: async () => { invalidationsDrained = true; },
    runtime,
  });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const failure = error as Partial<{ readonly code: string; readonly status: number }>;
      response.writeHead(failure.status ?? 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ diagnostic: { code: failure.code ?? 'AB8007' } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  const headers = { 'content-type': 'application/json', origin: 'http://127.0.0.1:4567', 'x-agent-bundle-session': 'runtime-token' };
  try {
    const stale = await fetch(`http://127.0.0.1:${address.port}/api/runtime/mcp/sessions/session-a/rpc`, {
      body: JSON.stringify({ expectedSessionRevision: 2, kind: 'list-tools' }), headers, method: 'POST',
    });
    expect(stale.status).toBe(409);
    const unknown = await fetch(`http://127.0.0.1:${address.port}/api/runtime/mcp/sessions/unknown-a/rpc`, {
      body: JSON.stringify({ expectedSessionRevision: 2, kind: 'list-tools' }), headers, method: 'POST',
    });
    expect(unknown.status).toBe(404);
    const restart = await fetch(`http://127.0.0.1:${address.port}/api/runtime/mcp/sessions/session-a/restart`, {
      body: JSON.stringify({ expectedSessionRevision: 2, sessionId: 'session-a' }), headers, method: 'POST',
    });
    expect(restart.status).toBe(409);
    expect(invalidationsDrained).toBe(true);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error)));
  }
});
