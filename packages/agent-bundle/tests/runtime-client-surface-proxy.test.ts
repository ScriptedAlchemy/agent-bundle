import { createServer, get as httpGet, globalAgent, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';
import WebSocket from 'ws';

import {
  RuntimeClientSurfaceProxy as RuntimeClientSurfaceProxyImplementation,
  runtimeClientSurfaceReloadChannelPath,
  type DevRuntimeClientSurfaceEndpoint,
} from '../src/dev/index.ts';
import { runtimeAppMessageLimits } from '../src/dev/runtime-app-message-limits.ts';

const foregroundOrigin = 'http://127.0.0.1:41999';
const noopSubscribeReload = (): (() => void) => () => undefined;
const reloadFrame = (generation: number): string => JSON.stringify({ generation, kind: 'runtime-app-reload' });

/** Provider-side reload authority stub: the trusted channel the proxy relays. */
const createReloadSource = () => {
  const listeners = new Set<() => void>();
  return Object.freeze({
    emit: (): void => { for (const listener of [...listeners]) listener(); },
    listenerCount: (): number => listeners.size,
    subscribeReload: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
};
const RuntimeClientSurfaceProxy = Object.freeze({
  open: (
    input: DevRuntimeClientSurfaceEndpoint,
    listener: Parameters<typeof RuntimeClientSurfaceProxyImplementation.open>[1],
  ) => RuntimeClientSurfaceProxyImplementation.open(input, listener, foregroundOrigin),
});

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
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
};

const canonicalEntry = '<!doctype html><main>runtime App</main>';

const serveBootstrapEntry = (
  request: IncomingMessage,
  response: ServerResponse,
  path = '/app/index.html',
): boolean => {
  if (request.url !== path) return false;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(canonicalEntry);
  return true;
};

type RuntimeProxyShellHarnessOptions = Readonly<{
  readonly fetch?: typeof globalThis.fetch;
}>;

const runtimeProxyShellHarness = async (
  binding: Awaited<ReturnType<typeof RuntimeClientSurfaceProxy.open>>,
  options: RuntimeProxyShellHarnessOptions = {},
) => {
  const bootstrap = await fetch(binding.bootstrapUrl, { redirect: 'manual' });
  expect(bootstrap.status).toBe(200);
  const source = /<script>\n([\s\S]+)\n<\/script>$/u.exec(await bootstrap.text())?.[1];
  if (source === undefined) throw new Error('Runtime proxy bootstrap did not contain its outer relay.');

  type Listener = (event: Readonly<Record<string, unknown>>) => void;
  type AddEventListener = (type: string, listener: Listener) => void;
  const listeners = new Map<string, Set<Listener>>();
  const addEventListener: AddEventListener = (type, listener) => {
    const registered = listeners.get(type) ?? new Set<Listener>();
    registered.add(listener);
    listeners.set(type, registered);
  };
  const emit = (type: string, event: Readonly<Record<string, unknown>> = {}): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const setTimer = (callback: () => void): number => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  };
  const clearTimer = (id: number): void => { timers.delete(id); };
  const runTimers = (): void => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  const appPosts: Array<Readonly<{ readonly message: unknown; readonly targetOrigin: string }>> = [];
  const parentPosts: Array<Readonly<{ readonly message: unknown; readonly targetOrigin: string }>> = [];
  const child = Object.freeze({
    postMessage: (message: unknown, targetOrigin: string) => { appPosts.push(Object.freeze({ message, targetOrigin })); },
  });
  const parentWindow = Object.freeze({
    postMessage: (message: unknown, targetOrigin: string) => { parentPosts.push(Object.freeze({ message, targetOrigin })); },
  });
  const entries: string[] = [];
  const app = Object.create(null) as { readonly contentWindow: typeof child; srcdoc: string };
  Object.defineProperty(app, 'contentWindow', { enumerable: true, value: child });
  Object.defineProperty(app, 'srcdoc', { set: (entry: string) => { entries.push(entry); } });
  const sockets: Array<{
    readonly emit: (type: 'close' | 'error' | 'message' | 'open', event?: Readonly<Record<string, unknown>>) => void;
    readonly url: string;
    close(): void;
  }> = [];
  class FakeWebSocket {
    readonly #listeners = new Map<string, Set<Listener>>();
    readonly url: string;
    #closed = false;

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }

    addEventListener(type: string, listener: Listener): void {
      const registered = this.#listeners.get(type) ?? new Set<Listener>();
      registered.add(listener);
      this.#listeners.set(type, registered);
    }

    close(): void {
      if (this.#closed) return;
      this.#closed = true;
      this.emit('close');
    }

    emit(type: 'close' | 'error' | 'message' | 'open', event: Readonly<Record<string, unknown>> = {}): void {
      for (const listener of this.#listeners.get(type) ?? []) listener(event);
    }
  }
  const execute = new Function(
    'document', 'parent', 'location', 'WebSocket', 'TextEncoder', 'fetch', 'addEventListener', 'setTimeout', 'clearTimeout',
    source,
  ) as (
    document: Readonly<{ getElementById(id: string): typeof app }> ,
    parent: Readonly<{ postMessage(message: unknown, targetOrigin: string): void }> ,
    location: Readonly<{ origin: string }> ,
    WebSocket: typeof FakeWebSocket,
    TextEncoder: typeof globalThis.TextEncoder,
    fetch: typeof globalThis.fetch,
    addEventListener: AddEventListener,
    setTimeout: (callback: () => void, milliseconds?: number) => number,
    clearTimeout: (id: number) => void,
  ) => void;
  execute(
    Object.freeze({ getElementById: () => app }),
    parentWindow,
    Object.freeze({ origin: binding.origin }),
    FakeWebSocket,
    TextEncoder,
    options.fetch ?? (async () => new Response('<!doctype html><main>replacement</main>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof globalThis.fetch,
    addEventListener,
    setTimer,
    clearTimer,
  );
  return Object.freeze({
    appPosts,
    emitChild: (data: unknown) => { emit('message', Object.freeze({ data, origin: 'null', ports: Object.freeze([]), source: child })); },
    emitParent: (data: unknown, origin = foregroundOrigin) => {
      emit('message', Object.freeze({ data, origin, ports: Object.freeze([]), source: parentWindow }));
    },
    entries,
    pagehide: () => { emit('pagehide'); },
    parentPosts,
    pendingTimers: () => timers.size,
    runTimers,
    sockets,
    source,
  });
};

it('keeps malformed opaque-child initialize messages from advancing the trusted outer relay', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  try {
    const shell = await runtimeProxyShellHarness(binding);
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'accessed' });
    const custom = Object.create({ inherited: true }) as Record<string, unknown>;
    custom.value = 'custom';
    const proxy = new Proxy({ value: 'proxy' }, {
      ownKeys: () => { throw new Error('untrusted ownKeys'); },
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let deep: unknown = { leaf: true };
    for (let depth = 0; depth < 33; depth += 1) deep = { child: deep };
    const nodes = Array.from({ length: 4_097 }, () => true);
    const malformed = [
      { value: new Date() },
      { value: new Map([['entry', 'value']]) },
      { value: custom },
      { value: accessor },
      { value: proxy },
      { value: cyclic },
      { value: deep },
      { value: nodes },
      { value: 'é'.repeat(runtimeAppMessageLimits.appToHostBytes) },
    ];
    for (const params of malformed) {
      shell.emitChild({ id: 'malformed', jsonrpc: '2.0', method: 'ui/initialize', params });
    }
    expect(shell.parentPosts).toEqual([]);
    shell.emitChild({
      id: 'valid', jsonrpc: '2.0', method: 'ui/initialize',
      params: { appCapabilities: {}, appInfo: { name: 'app', version: '1' }, protocolVersion: '2026-01-26' },
    });
    expect(shell.parentPosts).toEqual([{
      message: {
        id: 'valid', jsonrpc: '2.0', method: 'ui/initialize',
        params: { appCapabilities: {}, appInfo: { name: 'app', version: '1' }, protocolVersion: '2026-01-26' },
      },
      targetOrigin: foregroundOrigin,
    }]);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('queues host requests relayed during the App handshake and flushes them once the App reports initialized', async () => {
  // Regression for #23: a ui/resource-teardown relayed between the initialize
  // response and ui/notifications/initialized used to be dropped, so the host
  // burned its bounded teardown grace waiting for an acknowledgement that could
  // never arrive. The shell must queue (bounded) instead of dropping.
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  try {
    const shell = await runtimeProxyShellHarness(binding);
    const initialize = {
      id: 'init', jsonrpc: '2.0', method: 'ui/initialize',
      params: { appCapabilities: {}, appInfo: { name: 'app', version: '1' }, protocolVersion: '2026-01-26' },
    };
    const initializeResponse = { id: 'init', jsonrpc: '2.0', result: { hostContext: {} } };
    const teardown = { id: 'teardown', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} };
    const initialized = { jsonrpc: '2.0', method: 'ui/notifications/initialized' };

    // Host traffic before the App has even asked to initialize is queued too.
    shell.emitParent({ id: 'early', jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: {} });
    shell.emitChild(initialize);
    expect(shell.parentPosts.map((entry) => entry.message)).toEqual([initialize]);
    shell.emitParent(initializeResponse);
    expect(shell.appPosts.map((entry) => entry.message)).toEqual([initializeResponse]);

    // The race from #23: a teardown request lands inside the handshake window.
    shell.emitParent(teardown);
    // Foreign-origin and malformed host traffic is still rejected, never queued.
    shell.emitParent({ id: 'foreign', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} }, 'http://evil.example');
    shell.emitParent({ id: 'not-rpc', method: 'ui/resource-teardown' });
    // The queue is bounded: the 32-entry window already holds `early` and
    // `teardown`, so exactly 30 more fit and the rest are dropped.
    const filler = Array.from({ length: 40 }, (_, index) => ({ id: `fill-${String(index)}`, jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { index } }));
    for (const message of filler) shell.emitParent(message);
    expect(shell.appPosts).toHaveLength(1);

    shell.emitChild(initialized);
    expect(shell.parentPosts.map((entry) => entry.message)).toEqual([initialize, initialized]);
    const flushed = shell.appPosts.slice(1).map((entry) => entry.message);
    expect(flushed).toHaveLength(32);
    expect(flushed[0]).toEqual({ id: 'early', jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: {} });
    expect(flushed[1]).toEqual(teardown);
    expect(flushed.slice(2)).toEqual(filler.slice(0, 30));
    expect(shell.appPosts.every((entry) => entry.targetOrigin === '*')).toBe(true);

    // Once initialized, host traffic relays immediately and nothing is replayed twice.
    const late = { id: 'late', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} };
    shell.emitParent(late);
    expect(shell.appPosts).toHaveLength(34);
    expect(shell.appPosts.at(-1)?.message).toEqual(late);
    const acknowledgement = { id: 'teardown', jsonrpc: '2.0', result: {} };
    shell.emitChild(acknowledgement);
    expect(shell.parentPosts.at(-1)?.message).toEqual(acknowledgement);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('refreshes only for owned reload frames with advancing generations while reconnecting the channel', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  try {
    const shell = await runtimeProxyShellHarness(binding);
    expect(shell.sockets.map((socket) => socket.url)).toEqual([`${binding.origin}${runtimeClientSurfaceReloadChannelPath}`]);
    shell.sockets[0]!.emit('close');
    shell.sockets[0]!.emit('error');
    expect(shell.pendingTimers()).toBe(1);
    shell.runTimers();
    expect(shell.sockets.map((socket) => socket.url)).toEqual([
      `${binding.origin}${runtimeClientSurfaceReloadChannelPath}`,
      `${binding.origin}${runtimeClientSurfaceReloadChannelPath}`,
    ]);
    shell.sockets[1]!.emit('open');
    // Frames that are not this channel's owned reload protocol stay inert:
    // Rsbuild's private envelope (including its full-reload kind), unknown
    // kinds, missing/invalid generations, and non-advancing generations.
    shell.sockets[1]!.emit('message', { data: JSON.stringify({ type: 'full-reload' }) });
    shell.sockets[1]!.emit('message', { data: JSON.stringify({ type: 'ok' }) });
    shell.sockets[1]!.emit('message', { data: JSON.stringify({ type: 'hash', data: 'private-hash' }) });
    shell.sockets[1]!.emit('message', { data: JSON.stringify({ kind: 'runtime-app-reload' }) });
    shell.sockets[1]!.emit('message', { data: JSON.stringify({ generation: 1.5, kind: 'runtime-app-reload' }) });
    shell.sockets[1]!.emit('message', { data: JSON.stringify({ generation: 0, kind: 'runtime-app-reload' }) });
    shell.sockets[1]!.emit('message', { data: JSON.stringify({ generation: 1, kind: 'future-private-frame' }) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(shell.entries).toHaveLength(1);
    shell.sockets[1]!.emit('message', { data: reloadFrame(1) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(shell.entries).toHaveLength(2);
    // Replaying an already-seen generation never refreshes the child again.
    shell.sockets[1]!.emit('message', { data: reloadFrame(1) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(shell.entries).toHaveLength(2);
    shell.pagehide();
    shell.sockets[1]!.emit('close');
    expect(shell.pendingTimers()).toBe(0);
    shell.runTimers();
    expect(shell.sockets).toHaveLength(2);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('applies a reload announced while a refresh fetch is in flight once that fetch settles', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  const pendingFetches: Array<(response: Response) => void> = [];
  try {
    const shell = await runtimeProxyShellHarness(binding, {
      fetch: async () => new Promise<Response>((resolvePromise) => { pendingFetches.push(resolvePromise); }),
    });
    shell.sockets[0]!.emit('open');
    shell.sockets[0]!.emit('message', { data: reloadFrame(1) });
    expect(pendingFetches).toHaveLength(1);
    // A newer reload lands while the generation-1 fetch is still in flight.
    // The single-flight refresh must not swallow it: that fetch may predate
    // the newer compilation's output.
    shell.sockets[0]!.emit('message', { data: reloadFrame(2) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pendingFetches).toHaveLength(1);
    pendingFetches[0]!(new Response('<!doctype html><main>generation one</main>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    // Settling the in-flight fetch installs its entry, then immediately runs
    // a catch-up refresh for the generation announced mid-flight.
    await expect.poll(() => pendingFetches.length, { timeout: 5_000 }).toBe(2);
    expect(shell.entries).toHaveLength(2);
    pendingFetches[1]!(new Response('<!doctype html><main>generation two</main>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    await expect.poll(() => shell.entries.length, { timeout: 5_000 }).toBe(3);
    expect(shell.entries[2]).toContain('generation two');
    // The catch-up refresh proved generation 2, so replaying it stays inert.
    shell.sockets[0]!.emit('message', { data: reloadFrame(2) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pendingFetches).toHaveLength(2);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('retries a reload whose refresh failed when the channel replays that generation', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  let attempts = 0;
  try {
    const shell = await runtimeProxyShellHarness(binding, {
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient refresh failure');
        return new Response('<!doctype html><main>recovered</main>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    });
    shell.sockets[0]!.emit('open');
    shell.sockets[0]!.emit('message', { data: reloadFrame(1) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // The failed refresh leaves the admitted child intact and the reload
    // unapplied — a failure must not burn the generation.
    expect(shell.entries).toHaveLength(1);
    // The channel drops and reconnects; the server replays generation 1 on
    // every accepted connection, which retries the unapplied reload.
    shell.sockets[0]!.emit('close');
    shell.runTimers();
    shell.sockets[1]!.emit('open');
    shell.sockets[1]!.emit('message', { data: reloadFrame(1) });
    await expect.poll(() => shell.entries.length, { timeout: 5_000 }).toBe(2);
    expect(shell.entries[1]).toContain('recovered');
    expect(attempts).toBe(2);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('prefixes every opaque child entry with the closed CSP supplied by its trusted binding', async () => {
  const initialEntry = '<style>main{color:green}</style><script>window.inline=true</script><img src="data:image/png;base64,AA==">';
  const refreshedEntry = '<style>main{color:blue}</style><script>window.refreshed=true</script><img src="data:image/png;base64,AA==">';
  const upstream = createServer((request, response) => {
    if (request.url === '/app/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(initialEntry);
      return;
    }
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const childPolicy = "default-src 'none'; script-src 'unsafe-inline' \"<&";
  const binding = await RuntimeClientSurfaceProxyImplementation.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined, foregroundOrigin, Object.freeze({ contentSecurityPolicy: childPolicy }) as never);
  try {
    const shell = await runtimeProxyShellHarness(binding, {
      fetch: async () => new Response(refreshedEntry, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    });
    const prefix = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39; &quot;&lt;&amp;">';
    expect(shell.entries).toEqual([`${prefix}${initialEntry}`]);
    expect(shell.source).not.toContain('full-reload');
    expect(shell.source).toContain(runtimeClientSurfaceReloadChannelPath);

    shell.sockets[0]!.emit('open');
    shell.sockets[0]!.emit('message', { data: reloadFrame(1) });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(shell.entries).toEqual([`${prefix}${initialEntry}`, `${prefix}${refreshedEntry}`]);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('uses an exact empty-domain child CSP for direct non-MCP surface opens', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  try {
    const shell = await runtimeProxyShellHarness(binding);
    expect(shell.entries).toEqual([
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; base-uri &#39;self&#39;; connect-src &#39;none&#39;; frame-src &#39;none&#39;; img-src data:; media-src &#39;none&#39;; font-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; script-src &#39;unsafe-inline&#39;"><!doctype html><main>runtime App</main>',
    ]);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('rejects a custom-prototype child policy before opening a proxy binding', async () => {
  const policy = Object.create({ inherited: true }) as Record<string, unknown>;
  Object.defineProperty(policy, 'contentSecurityPolicy', {
    enumerable: true,
    value: "default-src 'none'",
  });
  await expect(RuntimeClientSurfaceProxyImplementation.open({
    entryPath: '/app/index.html',
    httpOrigin: 'http://127.0.0.1:41998',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined, foregroundOrigin, policy as never)).rejects.toThrow('plain policy record');
});

it('does not reinstall the opaque child when a held refresh fetch resolves after pagehide', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  let resolveFetch: ((response: Response) => void) | undefined;
  let refreshSignal: AbortSignal | null | undefined;
  const heldFetch = new Promise<Response>((resolvePromise) => { resolveFetch = resolvePromise; });
  try {
    const shell = await runtimeProxyShellHarness(binding, {
      fetch: (_input, init) => {
        refreshSignal = init?.signal;
        return heldFetch;
      },
    });
    shell.sockets[0]!.emit('open');
    shell.sockets[0]!.emit('message', { data: reloadFrame(1) });
    shell.pagehide();
    resolveFetch?.(new Response('<!doctype html><main>late fetch</main>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(shell.entries).toHaveLength(1);
    expect(refreshSignal?.aborted).toBe(true);
    expect(shell.appPosts).toEqual([]);
    expect(shell.parentPosts).toEqual([]);
    expect(shell.pendingTimers()).toBe(0);
    expect(shell.sockets).toHaveLength(1);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('does not reinstall the opaque child when held refresh text resolves after pagehide', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  let resolveText: ((entry: string) => void) | undefined;
  let refreshSignal: AbortSignal | null | undefined;
  let textStarted = false;
  const heldText = new Promise<string>((resolvePromise) => { resolveText = resolvePromise; });
  const response = Object.freeze({
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    ok: true,
    text: () => {
      textStarted = true;
      return heldText;
    },
  }) as unknown as Response;
  try {
    const shell = await runtimeProxyShellHarness(binding, {
      fetch: async (_input, init) => {
        refreshSignal = init?.signal;
        return response;
      },
    });
    shell.sockets[0]!.emit('open');
    shell.sockets[0]!.emit('message', { data: reloadFrame(1) });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(textStarted).toBe(true);
    shell.pagehide();
    resolveText?.('<!doctype html><main>late text</main>');
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(shell.entries).toHaveLength(1);
    expect(refreshSignal?.aborted).toBe(true);
    expect(shell.appPosts).toEqual([]);
    expect(shell.parentPosts).toEqual([]);
    expect(shell.pendingTimers()).toBe(0);
    expect(shell.sockets).toHaveLength(1);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('uses a one-use bootstrap capability before serving declared app assets and the owned reload channel', async () => {
  const upstream = createServer((request, response) => {
    if (request.url === '/app/index.html') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<main>runtime app</main>');
      return;
    }
    response.writeHead(404).end();
  });
  let upstreamUpgrades = 0;
  upstream.on('upgrade', (_request, socket) => {
    upstreamUpgrades += 1;
    socket.destroy();
  });
  const origin = await listen(upstream);
  const reloadSource = createReloadSource();
  const events: unknown[] = [];
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    subscribeReload: reloadSource.subscribeReload,
    surfaceId: 'app.weather',
  } satisfies DevRuntimeClientSurfaceEndpoint, (event) => events.push(event));

  try {
    expect(reloadSource.listenerCount()).toBe(1);
    const first = await fetch(binding.bootstrapUrl, { redirect: 'manual' });
    expect(first.status).toBe(200);
    expect(first.headers.get('content-security-policy')).toContain(`frame-ancestors ${foregroundOrigin}`);
    expect(first.headers.get('set-cookie')).toMatch(/^__Host-agent_bundle_runtime_[a-f0-9]+=/u);
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    expect(first.headers.get('set-cookie')).toContain('Secure');
    expect(first.headers.get('set-cookie')).toContain('SameSite=None');
    expect(first.headers.get('set-cookie')).toContain('Partitioned');
    expect(first.headers.get('set-cookie')).not.toContain('Domain=');
    const cookie = first.headers.get('set-cookie')!.split(';', 1)[0]!;
    const shell = await first.text();
    expect(shell).toContain('<iframe id="app" sandbox="allow-scripts"');
    expect(shell).toContain(`const maxAppToHostMessageBytes = ${runtimeAppMessageLimits.appToHostBytes};`);
    expect(shell).toContain(`const maxHostToAppMessageBytes = ${runtimeAppMessageLimits.hostToAppBytes};`);
    expect(shell).toContain("if (event.origin !== hostOrigin || !isRpc(event.data, maxHostToAppMessageBytes)) return;");
    expect(shell).toContain("!isRpc(event.data, maxAppToHostMessageBytes)");

    const second = await fetch(binding.bootstrapUrl, { redirect: 'manual' });
    expect(second.status).toBe(403);

    const rebootstrap = await fetch(binding.bootstrapUrl, { headers: { cookie }, redirect: 'manual' });
    expect(rebootstrap.status).toBe(403);
    expect((await fetch(`${binding.bootstrapUrl}?capability=forbidden`, { headers: { cookie }, redirect: 'manual' })).status).toBe(403);
    expect((await fetch(binding.bootstrapUrl, { headers: { cookie: `${cookie}wrong` }, redirect: 'manual' })).status).toBe(403);

    const asset = await fetch(`${binding.origin}/app/index.html`, { headers: { cookie } });
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain('runtime app');
    expect((await fetch(`${binding.origin}/not-declared.js`, { headers: { cookie } })).status).toBe(404);

    const client = new WebSocket(`${binding.origin.replace('http:', 'ws:')}${runtimeClientSurfaceReloadChannelPath}`, {
      headers: { cookie, origin: binding.origin },
    });
    const frames: string[] = [];
    client.on('message', (message) => frames.push(message.toString()));
    await new Promise<void>((resolvePromise, rejectPromise) => {
      client.once('open', resolvePromise);
      client.once('error', rejectPromise);
    });
    // The proxy replays its current generation on connect, then broadcasts
    // one advanced generation per provider reload event.
    await expect.poll(() => frames, { timeout: 5_000 }).toEqual([reloadFrame(0)]);
    reloadSource.emit();
    reloadSource.emit();
    await expect.poll(() => frames, { timeout: 5_000 }).toEqual([reloadFrame(0), reloadFrame(1), reloadFrame(2)]);
    client.close();

    // The compiler upstream saw HTTP asset requests only; the reload channel
    // terminates at the proxy and never dials Rsbuild's WebSocket.
    expect(upstreamUpgrades).toBe(0);
    expect(events).toContainEqual({ connectionCount: 1, surfaceId: 'app.weather', type: 'connected' });
    await binding.close();
    expect(reloadSource.listenerCount()).toBe(0);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('stops serving the bootstrap path after its binding closes', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);

  try {
    await bootstrapCookie(binding);
    await binding.close();
    await expect(fetch(binding.bootstrapUrl, { redirect: 'manual' })).rejects.toThrow();
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('rejects noncanonical foreground origins before exposing a bootstrap capability', async () => {
  const endpoint = {
    entryPath: '/app/index.html',
    httpOrigin: 'http://127.0.0.1:39001',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  };
  await expect(RuntimeClientSurfaceProxyImplementation.open(endpoint, () => undefined, 'http://127.0.0.1:42000/not-origin'))
    .rejects.toThrow('canonical foreground');
});

it('admits only clean authenticated same-origin upgrades on the owned reload channel', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    subscribeReload: noopSubscribeReload,
    surfaceId: 'app.weather',
  }, () => undefined);

  const connectionState = async (url: string, headers: Record<string, string>, protocols?: string[]): Promise<'close' | 'error' | 'open'> => {
    const client = new WebSocket(url, protocols, { headers });
    const state = await new Promise<'close' | 'error' | 'open'>((resolvePromise) => {
      client.once('close', () => resolvePromise('close'));
      client.once('error', () => resolvePromise('error'));
      client.once('open', () => resolvePromise('open'));
    });
    if (state === 'open') client.close();
    return state;
  };

  try {
    const cookie = await bootstrapCookie(binding);
    const channelUrl = `${binding.origin.replace('http:', 'ws:')}${runtimeClientSurfaceReloadChannelPath}`;
    // Query strings, foreign origins, missing cookies, undeclared paths, and
    // subprotocol negotiation never reach the owned channel.
    await expect(connectionState(`${channelUrl}?token=leaked`, { cookie, origin: binding.origin })).resolves.not.toBe('open');
    await expect(connectionState(channelUrl, { cookie, origin: 'null' })).resolves.not.toBe('open');
    await expect(connectionState(channelUrl, { origin: binding.origin })).resolves.not.toBe('open');
    await expect(connectionState(`${binding.origin.replace('http:', 'ws:')}/rsbuild-hmr`, { cookie, origin: binding.origin })).resolves.not.toBe('open');
    await expect(connectionState(channelUrl, { cookie, origin: binding.origin }, ['rsbuild'])).resolves.not.toBe('open');
    await expect(connectionState(channelUrl, { cookie, origin: binding.origin })).resolves.toBe('open');
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('refuses non-loopback compiler endpoints and reload channels without a provider authority', async () => {
  await expect(RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: 'https://compiler.example',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined)).rejects.toThrow('loopback');

  await expect(RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: 'http://127.0.0.1:3000',
    httpPathPrefixes: ['/app/'],
    subscribeReload: undefined as unknown as DevRuntimeClientSurfaceEndpoint['subscribeReload'],
    surfaceId: 'app.weather',
  }, () => undefined)).rejects.toThrow('subscribeReload');
});

it('never lets double-encoded traversal or delimiters escape a declared HTTP prefix', async () => {
  const paths: string[] = [];
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) {
      paths.push(request.url ?? '');
      return;
    }
    paths.push(request.url ?? '');
    response.writeHead(200).end('unexpected upstream reach');
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    for (const path of ['/app/%252e%252e/secret', '/app/%252fsecret', '/app/%253fsecret', '/app/%2523secret']) {
      expect((await fetch(`${binding.origin}${path}`, { headers: { cookie } })).status).toBe(404);
    }
    expect(paths).toEqual(['/app/index.html']);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('isolates browser cookie capabilities across concurrent client-surface bindings', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(200).end('ok');
  });
  const origin = await listen(upstream);
  const endpoint = {
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
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
      const client = new WebSocket(`${binding.origin.replace('http:', 'ws:')}${runtimeClientSurfaceReloadChannelPath}`, { headers: { cookie, origin: binding.origin } });
      client.once('open', () => {
        client.close();
        resolvePromise();
      });
      client.once('error', rejectPromise);
    })));
  } finally {
    await Promise.all([first.close(), second.close()]);
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('aborts a hanging upstream request when the downstream closes or its binding is closed', async () => {
  const nextRequests: Array<(request: IncomingMessage) => void> = [];
  const nextRequest = (): Promise<IncomingMessage> => new Promise((resolvePromise) => nextRequests.push(resolvePromise));
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response, '/app/entry.html')) return;
    nextRequests.shift()?.(request);
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/entry.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
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

it('keeps an in-flight binding B request alive when binding A closes on the same compiler origin', async () => {
  let completeB: (() => void) | undefined;
  const bReady = new Promise<void>((resolvePromise) => { completeB = resolvePromise; });
  let releaseB: (() => void) | undefined;
  const bReleased = new Promise<void>((resolvePromise) => { releaseB = resolvePromise; });
  const upstream = createServer(async (request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    if (request.url === '/app/a.js') {
      response.writeHead(200).end('a');
      return;
    }
    completeB?.();
    await bReleased;
    response.writeHead(200).end('b');
  });
  const origin = await listen(upstream);
  const endpoint = {
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  };
  const originalMaxSockets = globalAgent.maxSockets;
  globalAgent.maxSockets = 1;
  const [first, second] = await Promise.all([
    RuntimeClientSurfaceProxy.open(endpoint, () => undefined),
    RuntimeClientSurfaceProxy.open({ ...endpoint, surfaceId: 'app.calendar' }, () => undefined),
  ]);

  try {
    const [firstCookie, secondCookie] = await Promise.all([bootstrapCookie(first), bootstrapCookie(second)]);
    await expect(fetch(`${first.origin}/app/a.js`, { headers: { cookie: firstCookie } }).then((response) => response.text())).resolves.toBe('a');
    const b = fetch(`${second.origin}/app/b.js`, { headers: { cookie: secondCookie } });
    void b.catch(() => undefined);
    await bReady;
    await first.close();
    releaseB?.();
    await expect(within(b.then((response) => response.text()), 500)).resolves.toBe('b');
  } finally {
    globalAgent.maxSockets = originalMaxSockets;
    await Promise.all([first.close(), second.close()]);
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('bounds an upstream HTTP request before headers arrive', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response, '/app/entry.html')) return;
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/entry.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    const pending = fetch(`${binding.origin}/app/index.html`, { headers: { cookie } });
    void pending.catch(() => undefined);
    await expect(within(pending, 16_000)).resolves.toMatchObject({ status: 502 });
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
}, 20_000);

it('releases a reload-channel client that writes into the strictly one-way channel', async () => {
  const upstream = createServer((request, response) => {
    serveBootstrapEntry(request, response);
  });
  const origin = await listen(upstream);
  const events: unknown[] = [];
  const reloadSource = createReloadSource();
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    subscribeReload: reloadSource.subscribeReload,
    surfaceId: 'app.weather',
  }, (event) => events.push(event));

  try {
    const cookie = await bootstrapCookie(binding);
    const connectAndSend = async (payload: Buffer | string): Promise<void> => {
      const client = new WebSocket(`${binding.origin.replace('http:', 'ws:')}${runtimeClientSurfaceReloadChannelPath}`, { headers: { cookie, origin: binding.origin } });
      const closed = new Promise<void>((resolvePromise) => client.once('close', () => resolvePromise()));
      client.once('error', () => undefined);
      await new Promise<void>((resolvePromise, rejectPromise) => {
        client.once('open', resolvePromise);
        client.once('error', rejectPromise);
      });
      client.send(payload);
      await expect(within(closed, 1_000)).resolves.toBeUndefined();
    };
    await connectAndSend(Buffer.alloc(0));
    await connectAndSend('{"kind":"runtime-app-reload","generation":99}');
    // Every writing client was released, so the channel still serves a
    // well-behaved relay afterwards.
    const frames: string[] = [];
    const client = new WebSocket(`${binding.origin.replace('http:', 'ws:')}${runtimeClientSurfaceReloadChannelPath}`, { headers: { cookie, origin: binding.origin } });
    client.on('message', (message) => frames.push(message.toString()));
    await new Promise<void>((resolvePromise, rejectPromise) => {
      client.once('open', resolvePromise);
      client.once('error', rejectPromise);
    });
    reloadSource.emit();
    await expect.poll(() => frames, { timeout: 5_000 }).toEqual([reloadFrame(0), reloadFrame(1)]);
    client.close();
    expect(events.filter((event) => (event as { readonly type: string }).type === 'connected')).toHaveLength(3);
    await expect.poll(
      () => events.filter((event) => (event as { readonly type: string }).type === 'disconnected'),
      { timeout: 5_000 },
    ).toHaveLength(3);
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
}, 20_000);

it('destroys declared-oversize upstream bodies instead of releasing their binding early', async () => {
  let resolveSocketClosed: (() => void) | undefined;
  const socketClosed = new Promise<void>((resolvePromise) => { resolveSocketClosed = resolvePromise; });
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    request.socket.once('close', () => resolveSocketClosed?.());
    response.writeHead(200, { 'content-length': String((4 * 1024 * 1024) + 1) });
    response.write('never-ending');
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
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

it('destroys endless redirect bodies before releasing their binding', async () => {
  let resolveSocketClosed: (() => void) | undefined;
  const socketClosed = new Promise<void>((resolvePromise) => { resolveSocketClosed = resolvePromise; });
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response, '/app/entry.html')) return;
    request.socket.once('close', () => resolveSocketClosed?.());
    response.writeHead(302, { location: '/app/next' });
    response.write('never-ending');
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/entry.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    await expect(within(fetch(`${binding.origin}/app/index.html`, { headers: { cookie }, redirect: 'manual' }), 500)).resolves.toMatchObject({ status: 302 });
    await expect(within(socketClosed, 250)).resolves.toBeUndefined();
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
});

it('keeps a completed 502 response intact when a response body stalls after headers', async () => {
  let resolveSocketClosed: (() => void) | undefined;
  const socketClosed = new Promise<void>((resolvePromise) => { resolveSocketClosed = resolvePromise; });
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    request.socket.once('close', () => resolveSocketClosed?.());
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.write('stalled');
  });
  const origin = await listen(upstream);
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.weather',
    subscribeReload: noopSubscribeReload,
  }, () => undefined);

  try {
    const cookie = await bootstrapCookie(binding);
    const pending = fetch(`${binding.origin}/app/main.js`, { headers: { cookie } }).then(async (response) => ({
      body: await response.text(),
      status: response.status,
    }));
    void pending.catch(() => undefined);
    await expect(within(pending, 16_000)).resolves.toEqual({ body: 'Not Found', status: 502 });
    await expect(within(socketClosed, 250)).resolves.toBeUndefined();
  } finally {
    await binding.close();
    upstream.closeAllConnections();
    await close(upstream);
  }
}, 20_000);

it('bounds chunked upstream assets and releases their socket immediately', async () => {
  let resolveSocketClosed: (() => void) | undefined;
  const socketClosed = new Promise<void>((resolvePromise) => { resolveSocketClosed = resolvePromise; });
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
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
    subscribeReload: noopSubscribeReload,
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
    subscribeReload: noopSubscribeReload,
  }, () => undefined);
  await binding.close();

  await expect(RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: 'http://[::2]:39201',
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.ipv6',
    subscribeReload: noopSubscribeReload,
  }, () => undefined)).rejects.toThrow('loopback');
});

it('proxies through literal IPv6 loopback when the host supports it', async () => {
  const upstream = createServer((request, response) => {
    if (serveBootstrapEntry(request, response)) return;
    response.writeHead(200).end('ipv6');
  });
  const origin = await listenIpv6(upstream);
  if (origin === undefined) return;
  const binding = await RuntimeClientSurfaceProxy.open({
    entryPath: '/app/index.html',
    httpOrigin: origin,
    httpPathPrefixes: ['/app/'],
    surfaceId: 'app.ipv6',
    subscribeReload: noopSubscribeReload,
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
