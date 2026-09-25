import { describe, expect, it } from '@rstest/core';

import {
  createMcpAppFrameRelay,
  type McpAppFrameIframe,
  type McpAppFrameMessageListener,
  type McpAppFrameRelayRoutes,
  type McpAppFrameWindow,
} from '../../agent-bundle/src/web-host/browser/frame-relay.ts';
import type { McpAppJsonValue, McpAppRelayFrame, McpAppRouteClose, McpAppRouteMessages } from '../src/mcp/mcp-app-client.ts';
import { deferred, eventually } from './support/async.ts';

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
          allow: '',
          contentSecurityPolicy: "default-src 'none'",
          html: '<main>Weather</main>',
        },
      },
      targetOrigin: 'http://127.0.0.1:43124',
    }]);
  });

  it('provides a valid built App resource without imposing the runtime message-size limit', () => {
    const browser = fakeBrowser();
    const html = `<main>${'x'.repeat(frame.relay.maxMessageBytes)}</main>`;
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-built-app',
      frame,
      iframe: browser.iframe,
      resource: Object.freeze({ html, kind: 'resource' as const }),
      routes: {
        close: async () => closeResult(),
        forceClose: async () => true,
        message: async () => messageResult(),
      },
      window: browser.window,
    });
    relay.start();

    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    expect(browser.child.posts).toEqual([{
      message: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: {
          allow: frame.allow,
          contentSecurityPolicy: frame.policy.contentSecurityPolicy,
          html,
        },
      },
      targetOrigin: frame.targetOrigin,
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

  it('delivers an authenticated consent continuation only to its current proxy window', () => {
    const browser = fakeBrowser();
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather', frame, iframe: browser.iframe, resource,
      routes: { close: async () => closeResult(), forceClose: async () => true, message: async () => messageResult() },
      window: browser.window,
    });
    relay.start();
    expect(relay.deliverHostMessages([{ id: 'action-1', jsonrpc: '2.0', result: { continued: true } }])).toBe(true);
    expect(browser.child.posts).toEqual([{
      message: { id: 'action-1', jsonrpc: '2.0', result: { continued: true } }, targetOrigin: frame.targetOrigin,
    }]);
    relay.detach();
    expect(relay.deliverHostMessages([{ id: 'late', jsonrpc: '2.0', result: {} }])).toBe(false);
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

  // The attribute is what mcp-app-real.e2e waits on before it closes a
  // preview; each transition is published on the event that changes it.
  const publishedRelayStates = (browser: ReturnType<typeof fakeBrowser>): Readonly<{ readonly iframe: McpAppFrameIframe; readonly states: readonly string[] }> => {
    const states: string[] = [];
    return Object.freeze({
      iframe: Object.freeze({
        contentWindow: browser.iframe.contentWindow,
        setAttribute: (name: string, value: string) => {
          expect(name).toBe('data-mcp-app-relay-state');
          states.push(value);
        },
      }),
      states,
    });
  };

  it('publishes loading, ready, closing, and closed on the iframe as the relay moves through a graceful close', async () => {
    const browser = fakeBrowser();
    const published = publishedRelayStates(browser);
    const closeCalls: { readonly id: string }[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls.push(options);
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => true,
      message: async () => messageResult([], 'closed'),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 100, frame, iframe: published.iframe, resource, routes, window: browser.window });
    expect(published.states).toEqual([]);
    expect(relay.start()).toBe(true);
    expect(published.states).toEqual(['loading']);
    expect(relay.start()).toBe(false);
    expect(published.states).toEqual(['loading']);
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(published.states).toEqual(['loading', 'ready']);
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(published.states).toEqual(['loading', 'ready']);

    const closing = relay.close();
    expect(published.states).toEqual(['loading', 'ready', 'closing']);
    await eventually(() => closeCalls.length === 1);
    expect(published.states).toEqual(['loading', 'ready', 'closing']);
    browser.emit({ data: { id: closeCalls[0]!.id, jsonrpc: '2.0', result: {} }, origin: frame.targetOrigin, source: browser.child });
    await closing;
    expect(published.states).toEqual(['loading', 'ready', 'closing', 'closed']);
    await relay.close();
    expect(published.states).toEqual(['loading', 'ready', 'closing', 'closed']);
  });

  it('publishes closing and closed, never ready, around the forced DELETE of a proxy that never signaled readiness', async () => {
    const browser = fakeBrowser();
    const published = publishedRelayStates(browser);
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult();
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => messageResult(),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 30_000, frame, iframe: published.iframe, resource, routes, window: browser.window });
    relay.start();
    const closing = relay.close();
    expect(published.states).toEqual(['loading', 'closing']);
    await closing;
    expect(published.states).toEqual(['loading', 'closing', 'closed']);
    expect(closeCalls).toBe(0);
    expect(forceCloseCalls).toBe(1);
  });

  it('force-deletes a closing binding when the ready proxy never acknowledges the teardown frame', async () => {
    const browser = fakeBrowser();
    let closeCalls = 0;
    let forceClosed = false;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls += 1;
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceClosed = true;
        return true;
      },
      message: async () => messageResult(),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 1, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    await relay.close();

    expect(closeCalls).toBe(1);
    expect(forceClosed).toBe(true);
  });

  it('force-deletes immediately, without a teardown handshake or the timer, when the proxy never signaled readiness', async () => {
    const browser = fakeBrowser();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls += 1;
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => messageResult(),
    };
    // The full 30 s budget: a timer-driven fallback would fail this test.
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 30_000, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();

    await relay.close();

    expect(closeCalls).toBe(0);
    expect(forceCloseCalls).toBe(1);
    expect(relay.state).toBe('closed');
    expect(browser.child.posts).toEqual([]);
    // A proxy that reports ready after the close began is a late arrival, not
    // a reopened relay.
    expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(false);
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

  it('rejects nonordinary nested JSON at both proxy boundaries without throwing its message listener', async () => {
    const deep = (): unknown => {
      let value: unknown = Object.freeze({ leaf: true });
      for (let depth = 0; depth < 64; depth += 1) value = Object.freeze({ child: value });
      return value;
    };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const customPrototype = Object.create({ inherited: true });
    customPrototype.value = 'custom';
    const invalidValues: readonly unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => undefined,
      Symbol('untrusted'),
      new Date(),
      customPrototype,
      cyclic,
      deep(),
      Array.from({ length: 4_097 }, () => Object.freeze({})),
    ];

    for (const nested of invalidValues) {
      const browser = fakeBrowser();
      const messages: unknown[] = [];
      const relay = createMcpAppFrameRelay({
        bindingId: 'binding-weather', frame, iframe: browser.iframe, resource,
        routes: {
          close: async () => closeResult(),
          forceClose: async () => true,
          message: async (_bindingId, message) => {
            messages.push(message);
            return messageResult();
          },
        },
        window: browser.window,
      });
      relay.start();
      expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(true);
      const message = Object.freeze({ id: 'invalid', jsonrpc: '2.0' as const, method: 'ping', params: Object.freeze({ nested }) });
      const event = Object.freeze({ data: message, origin: frame.targetOrigin, source: browser.child });

      expect(relay.receive(event)).toBe(false);
      expect(() => browser.emit(event)).not.toThrow();
      expect(relay.deliverHostMessages([message as never])).toBe(false);
      expect(messages).toEqual([]);
    }
  });

  it('preserves null-prototype JSON with an enumerable own __proto__ value at both proxy boundaries', async () => {
    const browser = fakeBrowser();
    const messages: unknown[] = [];
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather', frame, iframe: browser.iframe, resource,
      routes: {
        close: async () => closeResult(),
        forceClose: async () => true,
        message: async (_bindingId, message) => {
          messages.push(message);
          return messageResult();
        },
      },
      window: browser.window,
    });
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, '__proto__', { enumerable: true, value: 'literal-data' });
    const inbound = Object.freeze({ id: 'inbound', jsonrpc: '2.0' as const, method: 'ping', params: payload });
    const outbound = Object.freeze({ id: 'outbound', jsonrpc: '2.0' as const, method: 'ping', params: payload });
    relay.start();
    expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(true);

    expect(relay.receive({ data: inbound, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    await eventually(() => messages.length === 1);
    expect(messages[0]).toBe(inbound);
    expect(relay.deliverHostMessages([outbound as never])).toBe(true);
    const delivered = browser.child.posts.at(-1) as { readonly message: unknown };
    expect(delivered.message).toBe(outbound);
    expect((delivered.message as { readonly params: object }).params).toBe(payload);
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

  it('makes repeated unmount cleanup a resolved no-op after the route has already closed the binding', async () => {
    const browser = fakeBrowser();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult(undefined, 'closed');
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => messageResult([], 'closed'),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(relay.receive({ data: { id: 'route-closed', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    await eventually(() => relay.state === 'closed');

    await relay.close();
    await relay.close();

    expect(closeCalls).toBe(0);
    expect(forceCloseCalls).toBe(0);
  });

  it('force-deletes a binding when already accepted relay traffic never settles during unmount cleanup', async () => {
    const browser = fakeBrowser();
    const hung = deferred<McpAppRouteMessages>();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult(undefined, 'closed');
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => hung.promise,
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 5, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(relay.receive({ data: { id: 'hung', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    const closing = relay.close();

    await eventually(() => forceCloseCalls === 1);
    await closing;

    expect(closeCalls).toBe(0);
  });

  it('collapses delivery-failure and timeout fallback into one force-delete attempt', async () => {
    const browser = fakeBrowser();
    const forced = deferred<boolean>();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls += 1;
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return forced.promise;
      },
      message: async () => { throw new Error('teardown acknowledgement was not delivered'); },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 20, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    const closing = relay.close();
    await eventually(() => closeCalls === 1);
    const id = 'mcp-app-frame-close:binding-weather';
    browser.emit({ data: { id, jsonrpc: '2.0', result: {} }, origin: frame.targetOrigin, source: browser.child });
    await eventually(() => forceCloseCalls === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(forceCloseCalls).toBe(1);

    forced.resolve(true);
    await closing;
  });
});
