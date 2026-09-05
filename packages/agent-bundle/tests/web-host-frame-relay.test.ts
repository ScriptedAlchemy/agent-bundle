import { describe, expect, it } from '@rstest/core';

import type {
  McpAppJsonValue,
  McpAppRelayFrame,
  McpAppRouteMessages,
} from '../src/contracts/mcp-apps.ts';
import {
  createMcpAppFrameRelay,
  type McpAppFrameMessageListener,
  type McpAppFrameWindow,
} from '../src/web-host/browser/frame-relay.ts';

const frame: McpAppRelayFrame = Object.freeze({
  allow: '',
  policy: Object.freeze({
    contentSecurityPolicy: "default-src 'none'",
    iframeAllow: '',
    permissionsPolicy: 'camera=()',
  }),
  referrerPolicy: 'no-referrer',
  relay: Object.freeze({ maxMessageBytes: 4_096, maxQueuedMessages: 2 }),
  sandbox: 'allow-scripts allow-same-origin',
  src: 'http://127.0.0.1:43124/#sandbox-configuration',
  targetOrigin: 'http://127.0.0.1:43124',
});

const resource = Object.freeze({ html: '<main>Weather</main>', kind: 'resource' as const });

const browser = (): {
  readonly child: { readonly posts: unknown[]; postMessage(message: unknown, targetOrigin: string): void };
  readonly emit: (data: unknown, origin?: string, source?: unknown) => void;
  readonly iframe: { readonly contentWindow: { readonly posts: unknown[]; postMessage(message: unknown, targetOrigin: string): void } };
  readonly window: McpAppFrameWindow;
} => {
  const listeners = new Set<McpAppFrameMessageListener>();
  const child = {
    posts: [] as unknown[],
    postMessage(message: unknown, targetOrigin: string): void {
      child.posts.push({ message, targetOrigin });
    },
  };
  return {
    child,
    emit: (data, origin = frame.targetOrigin, source = child) => {
      for (const listener of listeners) listener({ data, origin, source });
    },
    iframe: Object.freeze({ contentWindow: child }),
    window: Object.freeze({
      addEventListener: (_type: 'message', listener: McpAppFrameMessageListener) => { listeners.add(listener); },
      removeEventListener: (_type: 'message', listener: McpAppFrameMessageListener) => { listeners.delete(listener); },
    }),
  };
};

const messageResult = (
  messages: readonly McpAppJsonValue[] = [],
): McpAppRouteMessages => Object.freeze({
  accepted: true,
  lifecycle: 'initialized',
  messages,
});

describe('framework web host frame relay', () => {
  it('provides the canonical resource only to the exact sandbox proxy', () => {
    const environment = browser();
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather',
      frame,
      iframe: environment.iframe,
      resource,
      routes: {
        close: async () => ({ lifecycle: 'closed' }),
        forceClose: async () => true,
        message: async () => messageResult(),
      },
      window: environment.window,
    });
    relay.start();

    environment.emit(
      { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' },
      'http://127.0.0.1:43125',
    );
    expect(environment.child.posts).toEqual([]);

    environment.emit({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    expect(environment.child.posts).toEqual([{
      message: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: {
          allow: '',
          contentSecurityPolicy: "default-src 'none'",
          html: '<main>Weather</main>',
        },
      },
      targetOrigin: frame.targetOrigin,
    }]);
  });

  it('relays wildcard-targeted ui/initialize without an App-side request engine', async () => {
    const environment = browser();
    const received: McpAppJsonValue[] = [];
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather',
      frame,
      iframe: environment.iframe,
      resource,
      routes: {
        close: async () => ({ lifecycle: 'closed' }),
        forceClose: async () => true,
        message: async (_bindingId, message) => {
          received.push(message);
          return messageResult([{
            id: 'initialize-1',
            jsonrpc: '2.0',
            result: { protocolVersion: '2026-01-26' },
          }]);
        },
      },
      window: environment.window,
    });
    relay.start();
    environment.emit({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    const initialize = Object.freeze({
      id: 'initialize-1',
      jsonrpc: '2.0' as const,
      method: 'ui/initialize',
      params: Object.freeze({ target: '*' }),
    });

    environment.emit(initialize);
    await expect.poll(() => received.length).toBe(1);

    expect(received).toEqual([initialize]);
    expect(environment.child.posts.at(-1)).toEqual({
      message: {
        id: 'initialize-1',
        jsonrpc: '2.0',
        result: { protocolVersion: '2026-01-26' },
      },
      targetOrigin: frame.targetOrigin,
    });
  });

  it('detaches a remounted document without closing its binding', () => {
    const environment = browser();
    let forceCloses = 0;
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather',
      frame,
      iframe: environment.iframe,
      resource,
      routes: {
        close: async () => ({ lifecycle: 'closed' }),
        forceClose: async () => { forceCloses += 1; return true; },
        message: async () => messageResult(),
      },
      window: environment.window,
    });
    relay.start();
    relay.detach();

    environment.emit({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });

    expect(environment.child.posts).toEqual([]);
    expect(forceCloses).toBe(0);
  });
});
