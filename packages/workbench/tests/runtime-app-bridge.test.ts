import { expect, it } from '@rstest/core';

import {
  createBindingMcpClient,
  createRuntimeAppBridgeFactory,
} from '../src/inspector/adapter/runtime-app-bridge.ts';

const eventually = async (predicate: () => boolean, timeout = 300): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
};

const fakeBrowser = () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posts: unknown[] = [];
  const target = {
    postMessage(message: unknown, targetOrigin: string): void {
      posts.push(Object.freeze({ message, targetOrigin }));
    },
  };
  return Object.freeze({
    emit: (event: Readonly<{ readonly data: unknown; readonly origin: string; readonly source: unknown }>) => {
      let stopped = false;
      const message = Object.freeze({
        ...event,
        stopImmediatePropagation: () => { stopped = true; },
      }) as unknown as MessageEvent;
      for (const listener of [...listeners]) {
        listener(message);
        if (stopped) return;
      }
    },
    posts,
    target,
    window: Object.freeze({
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { listeners.add(listener); },
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => { listeners.delete(listener); },
    }),
  });
};

const withBrowser = async <Value>(run: (browser: ReturnType<typeof fakeBrowser>) => Promise<Value>): Promise<Value> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = fakeBrowser();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser.window, writable: true });
  try {
    return await run(browser);
  } finally {
    if (descriptor === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', descriptor);
  }
};

it('exposes the controller-owned official runtime App bridge boundary', () => {
  expect(typeof createBindingMcpClient).toBe('function');
  expect(typeof createRuntimeAppBridgeFactory).toBe('function');
});

it('uses the controller-owned attachment only for the exact preview session identity', async () => {
  const policy = Object.freeze({
    bindingId: 'runtime-binding',
    snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
  });
  let attachments = 0;
  const access = Object.freeze({
    client: Object.freeze({}),
    close: async () => undefined,
    sessionId: 'runtime-session-a',
    sessionRevision: 3,
  });
  const controller = {
    attachApp: async () => {
      attachments += 1;
      return access;
    },
  };
  const client = {
    currentDocumentPolicy: () => policy,
  };
  const preview = {
    binding: { id: 'runtime-binding', sessionId: 'runtime-session-a', sessionRevision: 3 },
    documentPolicy: { revision: 1 },
    kind: 'apps',
  };

  await expect(createBindingMcpClient(controller as never, client as never, preview as never)).resolves.toBe(access);
  expect(attachments).toBe(1);

  await expect(createBindingMcpClient(controller as never, client as never, {
    ...preview,
    binding: { ...preview.binding, sessionRevision: 4 },
  } as never)).rejects.toThrow('session identity');
});

it('guards the official bridge to one source and origin while routing only tools and resources', async () => {
  await withBrowser(async (browser) => {
    const policy = Object.freeze({
      bindingId: 'runtime-binding',
      snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
    });
    const requests: string[] = [];
    let revoked = 0;
    const attachedClient = Object.freeze({
      getServerCapabilities: () => Object.freeze({
        resources: Object.freeze({ listChanged: true }),
        tools: Object.freeze({ listChanged: true }),
      }),
      request: async (request: Readonly<{ readonly method: string }>) => {
        requests.push(request.method);
        if (request.method === 'tools/list') return Object.freeze({ tools: Object.freeze([]) });
        if (request.method === 'resources/list') return Object.freeze({ resources: Object.freeze([]) });
        throw new Error(`Unexpected attached request ${request.method}.`);
      },
      setNotificationHandler: () => undefined,
    });
    const preview = Object.freeze({
      binding: Object.freeze({ id: 'runtime-binding', profileVersion: 'agent-bundle:mcp-apps:2026-01-26', sessionId: 'runtime-session-a', sessionRevision: 3 }),
      clientSurface: Object.freeze({ bootstrapUrl: 'https://apps.example.test/proxy', origin: 'https://apps.example.test', webSocketPath: '/rsbuild-hmr' as const }),
      documentPolicy: policy.snapshot,
      kind: 'apps' as const,
      profile: Object.freeze({ hostContext: Object.freeze({ availableDisplayModes: Object.freeze(['inline', 'fullscreen']), displayMode: 'inline', safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }), theme: 'light' }) }),
      resource: Object.freeze({ csp: Object.freeze({}), permissions: Object.freeze({}) }),
    });
    const factory = createRuntimeAppBridgeFactory({
      client: {
        closeRuntime: async () => { revoked += 1; },
        createRuntimeConsent: async () => { throw new Error('No side effect should be requested.'); },
        currentDocumentPolicy: () => policy,
        decideRuntimeConsent: async () => { throw new Error('No side effect should be requested.'); },
      } as never,
      controller: {
        attachApp: async () => Object.freeze({
          client: attachedClient,
          close: async () => undefined,
          sessionId: 'runtime-session-a',
          sessionRevision: 3,
        }),
      } as never,
      installedHandlers: Object.freeze({}),
      listChanged: Object.freeze({ resources: true, tools: true }),
      onTrace: () => undefined,
      preview: preview as never,
      requestConsent: async () => 'deny',
      simulationFeatures: Object.freeze({ chatGptWidgetState: 'disabled' as const }),
    });
    const bridge = await factory(Object.freeze({ contentWindow: browser.target }) as never, Object.freeze({ name: 'weather' }) as never);

    browser.emit({
      data: { id: 'initialize-wrong-origin', jsonrpc: '2.0', method: 'ui/initialize', params: { appCapabilities: {}, appInfo: { name: 'app', version: '1' }, protocolVersion: '2026-01-26' } },
      origin: 'https://other.example.test',
      source: browser.target,
    });
    browser.emit({
      data: { id: 'initialize-wrong-window', jsonrpc: '2.0', method: 'ui/initialize', params: { appCapabilities: {}, appInfo: { name: 'app', version: '1' }, protocolVersion: '2026-01-26' } },
      origin: 'https://apps.example.test',
      source: {},
    });
    expect(browser.posts).toEqual([]);

    browser.emit({
      data: { id: 'initialize', jsonrpc: '2.0', method: 'ui/initialize', params: { appCapabilities: {}, appInfo: { name: 'app', version: '1' }, protocolVersion: '2026-01-26' } },
      origin: 'https://apps.example.test',
      source: browser.target,
    });
    await eventually(() => browser.posts.length === 1);
    expect(browser.posts).toEqual([{
      message: expect.objectContaining({ id: 'initialize', jsonrpc: '2.0', result: expect.objectContaining({
        hostCapabilities: expect.objectContaining({ serverResources: { listChanged: true }, serverTools: { listChanged: true } }),
      }) }),
      targetOrigin: 'https://apps.example.test',
    }]);
    const initialization = (browser.posts[0] as { readonly message: { readonly result: { readonly hostCapabilities: Record<string, unknown> } } }).message.result;
    expect(initialization.hostCapabilities).not.toHaveProperty('prompts');
    expect(initialization.hostCapabilities).not.toHaveProperty('downloadFile');
    expect(initialization.hostCapabilities).not.toHaveProperty('openLinks');

    for (const [id, method] of [['tools', 'tools/list'], ['resources', 'resources/list'], ['templates', 'resources/templates/list'], ['prompts', 'prompts/list']] as const) {
      browser.emit({ data: { id, jsonrpc: '2.0', method, params: {} }, origin: 'https://apps.example.test', source: browser.target });
    }
    await eventually(() => requests.length === 2);
    expect(requests).toEqual(['tools/list', 'resources/list']);
    const oversized = Object.freeze({ jsonrpc: '2.0', method: 'ping', payload: 'x'.repeat(256 * 1024) });
    browser.emit({ data: oversized, origin: 'https://apps.example.test', source: browser.target });
    browser.emit({ data: oversized, origin: 'https://apps.example.test', source: browser.target });
    browser.emit({ data: oversized, origin: 'https://apps.example.test', source: browser.target });
    await eventually(() => revoked === 1);
    await bridge.close();
  });
});
