import { createServer, get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';
import WebSocket, { WebSocketServer } from 'ws';

import { RuntimeClientSurfaceProxy, type DevRuntimeClientSurfaceEndpoint } from '../src/dev/index.ts';

const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const listenIpv6 = async (server: ReturnType<typeof createServer>): Promise<string | undefined> => new Promise((resolvePromise, rejectPromise) => {
  const failed = (error: Error): void => {
    server.off('listening', listening);
    if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') {
      resolvePromise(undefined);
      return;
    }
    rejectPromise(error);
  };
  const listening = (): void => {
    server.off('error', failed);
    const address = server.address() as AddressInfo;
    resolvePromise(`http://[::1]:${address.port}`);
  };
  server.once('error', failed);
  server.once('listening', listening);
  server.listen({ host: '::1', port: 0 });
});

const close = async (server: ReturnType<typeof createServer>): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
});

const within = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => Promise.race([
  promise,
  new Promise<T>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

const bootstrapCookie = async (binding: Awaited<ReturnType<typeof RuntimeClientSurfaceProxy.open>>): Promise<string> => {
  const response = await fetch(binding.bootstrapUrl, { redirect: 'manual' });
  expect(response.status).toBe(302);
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
};

it('uses a one-use bootstrap capability before proxying only the declared app and Rsbuild HMR endpoints', async () => {
  const upstream = createServer((request, response) => {
    if (request.url === '/app/index.html') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<main>runtime app</main>');
      return;
    }
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const webSocketServer = new WebSocketServer({ noServer: true });
  let receivedUpgrade: { readonly protocol: string | undefined; readonly url: string | undefined } | undefined;
  upstream.on('upgrade', (request, socket, head) => {
    receivedUpgrade = { protocol: request.headers['sec-websocket-protocol'], url: request.url };
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });
  webSocketServer.on('connection', (socket) => socket.on('message', (message) => socket.send(message)));

  const events: unknown[] = [];
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/', '/rsbuild-hmr'],
    surfaceId: 'app.weather',
    webSocketOrigin: origin.replace('http:', 'ws:'),
    webSocketPath: '/rsbuild-hmr',
  } satisfies DevRuntimeClientSurfaceEndpoint, (event) => events.push(event));

  try {
    const first = await fetch(binding.bootstrapUrl, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    const cookie = first.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect(first.headers.get('location')).toBe('/app/index.html');

    const second = await fetch(binding.bootstrapUrl, { redirect: 'manual' });
    expect(second.status).toBe(403);

    const asset = await fetch(`${binding.origin}/app/index.html`, { headers: { cookie } });
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain('runtime app');
    expect((await fetch(`${binding.origin}/not-declared.js`, { headers: { cookie } })).status).toBe(404);

    const proxied = new WebSocket(`${binding.origin.replace('http:', 'ws:')}/rsbuild-hmr?token=hmr-a`, 'rsbuild', {
      headers: { cookie },
    });
    const response = new Promise<string>((resolvePromise, rejectPromise) => {
      proxied.once('message', (message) => resolvePromise(message.toString()));
      proxied.once('error', rejectPromise);
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      proxied.once('open', resolvePromise);
      proxied.once('error', rejectPromise);
    });
    proxied.send('refresh');
    await expect(response).resolves.toBe('refresh');
    proxied.close();

    expect(receivedUpgrade).toEqual({ protocol: 'rsbuild', url: '/rsbuild-hmr?token=hmr-a' });
    expect(events).toContainEqual({ connectionCount: 1, surfaceId: 'app.weather', type: 'connected' });
  } finally {
    await binding.close();
    webSocketServer.clients.forEach((client) => client.terminate());
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('refuses non-loopback and mismatched compiler endpoints before opening a browser origin', async () => {
  await expect(RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: 'https://compiler.example',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    webSocketOrigin: 'wss://compiler.example',
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined)).rejects.toThrow('loopback');

  await expect(RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: 'http://127.0.0.1:3000',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    webSocketOrigin: 'ws://127.0.0.1:3001',
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined)).rejects.toThrow('matching host and port');
});

it('never lets double-encoded traversal or delimiters escape a declared HTTP prefix', async () => {
  const paths: string[] = [];
  const upstream = createServer((request, response) => {
    paths.push(request.url ?? '');
    response.writeHead(200).end('unexpected upstream reach');
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    webSocketOrigin: origin.replace('http:', 'ws:'),
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    for (const path of ['/app/%252e%252e/secret', '/app/%252fsecret', '/app/%253fsecret', '/app/%2523secret']) {
      expect((await fetch(`${binding.origin}${path}`, { headers: { cookie } })).status).toBe(404);
    }
    expect(paths).toEqual([]);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('isolates browser cookie capabilities across concurrent client-surface bindings', async () => {
  const upstream = createServer((_request, response) => response.writeHead(200).end('ok'));
  const origin = await listen(upstream);
  const webSocketServer = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit('connection', client, request);
  }));
  const endpoint = {
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    webSocketOrigin: origin.replace('http:', 'ws:'),
    webSocketPath: '/rsbuild-hmr' as const,
  };
  const [first, second] = await Promise.all([
    RuntimeClientSurfaceProxy.open(endpoint, () => undefined),
    RuntimeClientSurfaceProxy.open({ ...endpoint, surfaceId: 'app.calendar' }, () => undefined),
  ]);

  try {
    const cookie = [await bootstrapCookie(first), await bootstrapCookie(second)].join('; ');
    expect((await fetch(`${first.origin}/app/index.html`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${second.origin}/app/index.html`, { headers: { cookie } })).status).toBe(200);
    await Promise.all([first, second].map((binding) => new Promise<void>((resolvePromise, rejectPromise) => {
      const client = new WebSocket(`${binding.origin.replace('http:', 'ws:')}/rsbuild-hmr`, { headers: { cookie } });
      client.once('open', () => {
        client.close();
        resolvePromise();
      });
      client.once('error', rejectPromise);
    })));
  } finally {
    await Promise.all([first.close(), second.close()]);
    webSocketServer.clients.forEach((client) => client.terminate());
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('aborts a hanging upstream request when the downstream closes or its binding is closed', async () => {
  const nextRequests: Array<(request: IncomingMessage) => void> = [];
  const nextRequest = (): Promise<IncomingMessage> => new Promise((resolvePromise) => nextRequests.push(resolvePromise));
  const upstream = createServer((request) => nextRequests.shift()?.(request));
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    webSocketOrigin: origin.replace('http:', 'ws:'),
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    const firstReceived = nextRequest();
    const request = httpGet(`${binding.origin}/app/index.html`, { headers: { cookie } });
    request.once('error', () => undefined);
    const upstreamRequest = await firstReceived;
    const upstreamAborted = new Promise<void>((resolvePromise) => upstreamRequest.once('aborted', resolvePromise));
    request.destroy();
    await expect(within(upstreamAborted, 250)).resolves.toBeUndefined();

    const secondReceived = nextRequest();
    const secondRequest = httpGet(`${binding.origin}/app/index.html`, { headers: { cookie } });
    secondRequest.once('error', () => undefined);
    const secondUpstreamRequest = await secondReceived;
    const closedUpstream = new Promise<void>((resolvePromise) => secondUpstreamRequest.once('aborted', resolvePromise));
    await binding.close();
    secondRequest.destroy();
    await expect(within(closedUpstream, 250)).resolves.toBeUndefined();
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('bounds chunked upstream assets and releases their socket immediately', async () => {
  let resolveSocketClosed: (() => void) | undefined;
  const socketClosed = new Promise<void>((resolvePromise) => { resolveSocketClosed = resolvePromise; });
  const upstream = createServer((request, response) => {
    request.socket.once('close', () => resolveSocketClosed?.());
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.write(Buffer.alloc((4 * 1024 * 1024) + 1));
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    webSocketOrigin: origin.replace('http:', 'ws:'),
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    await expect(within(fetch(`${binding.origin}/app/main.js`, { headers: { cookie } }), 500)).resolves.toMatchObject({ status: 413 });
    await expect(within(socketClosed, 250)).resolves.toBeUndefined();
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('accepts matched literal IPv6 loopback endpoints and rejects other IPv6 hosts', async () => {
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: 'http://[::1]:39201',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.ipv6',
    webSocketOrigin: 'ws://[::1]:39201',
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined);
  await binding.close();

  await expect(RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: 'http://[::2]:39201',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.ipv6',
    webSocketOrigin: 'ws://[::2]:39201',
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined)).rejects.toThrow('loopback');
});

it('proxies through literal IPv6 loopback when the host supports it', async () => {
  const upstream = createServer((_request, response) => response.writeHead(200).end('ipv6'));
  const origin = await listenIpv6(upstream);
  if (origin === undefined) return;
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.ipv6',
    webSocketOrigin: origin.replace('http:', 'ws:'),
    webSocketPath: '/rsbuild-hmr',
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    await expect(fetch(`${binding.origin}/app/index.html`, { headers: { cookie } })).resolves.toMatchObject({ status: 200 });
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});
