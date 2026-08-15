import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import {
  createMcpAppFrameRelay,
  McpAppFrame,
  type McpAppFrameMessageListener,
  type McpAppFrameRelayRoutes,
  type McpAppFrameWindow,
} from '../src/mcp/mcp-app-frame.tsx';
import type { McpAppJsonValue, McpAppRelayFrame, McpAppRouteClose, McpAppRouteMessages } from '../src/mcp/mcp-app-client.ts';

const frame: McpAppRelayFrame = Object.freeze({
  allow: '',
  policy: Object.freeze({
    contentSecurityPolicy: "default-src 'none'",
    iframeAllow: '',
    permissionsPolicy: 'camera=()',
  }),
  referrerPolicy: 'no-referrer',
  relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 2 }),
  sandbox: 'allow-scripts allow-same-origin',
  src: 'http://127.0.0.1:43124/#sandbox-configuration',
  targetOrigin: 'http://127.0.0.1:43124',
});

const resource = Object.freeze({
  csp: Object.freeze({ connectDomains: Object.freeze(['https://api.example.test']) }),
  html: '<main>Weather</main>',
  kind: 'resource' as const,
  permissions: Object.freeze({ clipboardWrite: Object.freeze({}) }),
});

const eventually = async (predicate: () => boolean, timeout = 300): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
};

const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

const messageResult = (messages: readonly McpAppJsonValue[] = [], lifecycle: McpAppRouteMessages['lifecycle'] = 'initialized'): McpAppRouteMessages =>
  Object.freeze({ accepted: true, lifecycle, messages });

const closeResult = (message: McpAppJsonValue | undefined = undefined, lifecycle: McpAppRouteClose['lifecycle'] = 'closing'): McpAppRouteClose =>
  Object.freeze({ ...(message === undefined ? {} : { message }), lifecycle });

const fakeBrowser = (): {
  readonly child: { readonly posts: unknown[]; postMessage(message: unknown, targetOrigin: string): void };
  readonly emit: (event: Readonly<{ readonly data: unknown; readonly origin: string; readonly source: unknown }>) => void;
  readonly iframe: { readonly contentWindow: { readonly posts: unknown[]; postMessage(message: unknown, targetOrigin: string): void } };
  readonly window: McpAppFrameWindow;
} => {
  const listeners = new Set<McpAppFrameMessageListener>();
  const child = {
    posts: [] as unknown[],
    postMessage(message: unknown, targetOrigin: string): void {
      child.posts.push(Object.freeze({ message, targetOrigin }));
    },
  };
  return {
    child,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    iframe: Object.freeze({ contentWindow: child }),
    window: Object.freeze({
      addEventListener: (_type: 'message', listener: McpAppFrameMessageListener) => { listeners.add(listener); },
      removeEventListener: (_type: 'message', listener: McpAppFrameMessageListener) => { listeners.delete(listener); },
    }),
  };
};

const proxyReady = (): Readonly<Record<string, unknown>> => Object.freeze({
  jsonrpc: '2.0',
  method: 'ui/notifications/sandbox-proxy-ready',
  params: Object.freeze({}),
});

describe('MCP App frame relay', () => {
  it('accepts only its exact proxy source and origin before providing the canonical resource without an authenticated route call', () => {
    const browser = fakeBrowser();
    const messages: unknown[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async () => closeResult(),
      forceClose: async () => true,
      message: async (_bindingId, message) => {
        messages.push(message);
        return messageResult();
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();

    browser.emit({ data: proxyReady(), origin: 'http://127.0.0.1:43125', source: browser.child });
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: {} });
    expect(browser.child.posts).toEqual([]);
    expect(messages).toEqual([]);

    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    expect(messages).toEqual([]);
    expect(browser.child.posts).toEqual([{
      message: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: {
          csp: { connectDomains: ['https://api.example.test'] },
          html: '<main>Weather</main>',
          permissions: { clipboardWrite: {} },
        },
      },
      targetOrigin: 'http://127.0.0.1:43124',
    }]);
  });

  it('forwards valid frames one at a time and returns ordered server frames only to its exact proxy origin', async () => {
    const browser = fakeBrowser();
    const first = deferred<McpAppRouteMessages>();
    const second = deferred<McpAppRouteMessages>();
    const calls: unknown[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async () => closeResult(),
      forceClose: async () => true,
      message: async (_bindingId, message) => {
        calls.push(message);
        return calls.length === 1 ? first.promise : second.promise;
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    const firstRequest = Object.freeze({ id: 'one', jsonrpc: '2.0', method: 'ping', params: Object.freeze({}) });
    const secondRequest = Object.freeze({ id: 'two', jsonrpc: '2.0', method: 'ping', params: Object.freeze({}) });

    browser.emit({ data: firstRequest, origin: frame.targetOrigin, source: browser.child });
    browser.emit({ data: secondRequest, origin: frame.targetOrigin, source: browser.child });
    await eventually(() => calls.length === 1);
    expect(calls).toEqual([firstRequest]);

    first.resolve(messageResult([{ id: 'one', jsonrpc: '2.0', result: { ready: 1 } }]));
    await eventually(() => calls.length === 2);
    expect(calls).toEqual([firstRequest, secondRequest]);
    second.resolve(messageResult([{ id: 'two', jsonrpc: '2.0', result: { ready: 2 } }]));
    await eventually(() => browser.child.posts.length === 3);

    expect(browser.child.posts.slice(1)).toEqual([
      { message: { id: 'one', jsonrpc: '2.0', result: { ready: 1 } }, targetOrigin: frame.targetOrigin },
      { message: { id: 'two', jsonrpc: '2.0', result: { ready: 2 } }, targetOrigin: frame.targetOrigin },
    ]);
  });

  it('waits for the trusted teardown acknowledgement before releasing the route and never processes further frames', async () => {
    const browser = fakeBrowser();
    const closeCalls: unknown[] = [];
    const messages: unknown[] = [];
    let forceClosed = false;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls.push(options);
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceClosed = true;
        return true;
      },
      message: async (_bindingId, message) => {
        messages.push(message);
        return messageResult([], 'closed');
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 100, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    const closing = relay.close();
    await eventually(() => closeCalls.length === 1);
    const id = (closeCalls[0] as { readonly id: string }).id;
    browser.emit({ data: { id, jsonrpc: '2.0', result: {} }, origin: frame.targetOrigin, source: browser.child });
    await closing;

    expect(messages).toEqual([{ id, jsonrpc: '2.0', result: {} }]);
    expect(forceClosed).toBe(false);
    browser.emit({ data: { id: 'late', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child });
    expect(messages).toHaveLength(1);
  });

  it('force-deletes a closing binding when the proxy never acknowledges the teardown frame', async () => {
    const browser = fakeBrowser();
    let forceClosed = false;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} }),
      forceClose: async () => {
        forceClosed = true;
        return true;
      },
      message: async () => messageResult(),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 1, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();

    await relay.close();

    expect(forceClosed).toBe(true);
  });

  it('renders the exact server-issued sandbox URL and no inline document or credential-bearing attribute', () => {
    const markup = renderToStaticMarkup(createElement(McpAppFrame, {
      bindingId: 'binding-weather',
      frame,
      resource,
      routes: {
        close: async () => closeResult(),
        forceClose: async () => true,
        message: async () => messageResult(),
      },
    }));

    expect(markup).toContain('src="http://127.0.0.1:43124/#sandbox-configuration"');
    expect(markup).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).not.toContain('srcdoc=');
    expect(markup).not.toContain('foreground-secret');
  });

  it('rejects binding-id smuggling and oversized frames while bounding queued relay work', async () => {
    const browser = fakeBrowser();
    const first = deferred<McpAppRouteMessages>();
    const calls: unknown[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async () => closeResult(),
      forceClose: async () => true,
      message: async (_bindingId, message) => {
        calls.push(message);
        return first.promise;
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(true);

    expect(relay.receive({
      data: { bindingId: 'another-binding', id: 'wrong-binding', jsonrpc: '2.0', method: 'ping' },
      origin: frame.targetOrigin,
      source: browser.child,
    })).toBe(false);
    expect(relay.receive({
      data: { id: 'too-large', jsonrpc: '2.0', method: 'ping', params: { value: 'x'.repeat(frame.relay.maxMessageBytes) } },
      origin: frame.targetOrigin,
      source: browser.child,
    })).toBe(false);
    expect(relay.receive({ data: { id: 'one', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    expect(relay.receive({ data: { id: 'two', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    expect(relay.receive({ data: { id: 'three', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(false);
    await eventually(() => calls.length === 1);
    expect(calls).toEqual([{ id: 'one', jsonrpc: '2.0', method: 'ping' }]);

    first.resolve(messageResult());
  });

  it('always queues its close operation behind already accepted traffic even when normal relay capacity is exhausted', async () => {
    const browser = fakeBrowser();
    const active = deferred<McpAppRouteMessages>();
    let closeCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult(undefined, 'closed');
      },
      forceClose: async () => true,
      message: async () => active.promise,
    };
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather',
      frame: Object.freeze({ ...frame, relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 1 }) }),
      iframe: browser.iframe,
      resource,
      routes,
      window: browser.window,
    });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(relay.receive({ data: { id: 'active', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    const closing = relay.close();
    active.resolve(messageResult());
    await closing;

    expect(closeCalls).toBe(1);
  });
});
