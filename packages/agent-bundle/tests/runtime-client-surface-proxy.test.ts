import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';
import WebSocket, { WebSocketServer } from 'ws';

import { RuntimeClientSurfaceProxy, type DevRuntimeClientSurfaceEndpoint } from '../src/dev/index.ts';

const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: ReturnType<typeof createServer>): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
});

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
