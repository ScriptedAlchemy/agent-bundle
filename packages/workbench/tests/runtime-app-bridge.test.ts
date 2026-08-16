import { expect, it } from '@rstest/core';
import type { McpAppBindingOperation } from '../../agent-bundle/src/dev/mcp-app-runtime-preview-service.ts';
import type { McpSessionControllerAppAttachment } from '../src/mcp/mcp-session-controller.ts';

import {
  createBindingMcpClient,
  createRuntimeAppBridgeFactory,
  type RuntimeAppBridgeFactory,
} from '../src/inspector/adapter/runtime-app-bridge.ts';

const eventually = async (predicate: () => boolean, timeout = 300): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
};

const fakeBrowser = (options: Readonly<{ readonly failMessageRegistration?: boolean }> = {}) => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posts: Array<Readonly<{ readonly message: unknown; readonly targetOrigin: string }>> = [];
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
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        if (options.failMessageRegistration) throw new Error('message registration failed');
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => { listeners.delete(listener); },
    }),
  });
};

const withBrowser = async <Value>(
  run: (browser: ReturnType<typeof fakeBrowser>) => Promise<Value>,
  options: Readonly<{ readonly failMessageRegistration?: boolean }> = {},
): Promise<Value> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = fakeBrowser(options);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser.window, writable: true });
  try {
    return await run(browser);
  } finally {
    if (descriptor === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', descriptor);
  }
};

const deferred = <Value>() => {
  let reject: (reason?: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const bridgeFactoryClose = (factory: unknown): (() => Promise<void>) | undefined => {
  const close = Reflect.get(factory as object, 'close');
  return typeof close === 'function' ? close as () => Promise<void> : undefined;
};

const appAccess = (close: () => Promise<void>) => Object.freeze({
  client: Object.freeze({
    getServerCapabilities: () => Object.freeze({}),
    request: async () => Object.freeze({}),
    setNotificationHandler: () => undefined,
  }),
  close,
  sessionId: 'runtime-session-a',
  sessionRevision: 3,
});

const runtimeFactory = (attachApp: () => Promise<ReturnType<typeof appAccess>>): RuntimeAppBridgeFactory => {
  const policy = Object.freeze({
    bindingId: 'runtime-binding',
    snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
  });
  return createRuntimeAppBridgeFactory({
    client: Object.freeze({
      closeRuntime: async () => undefined,
      currentDocumentPolicy: () => policy,
    }) as never,
    controller: Object.freeze({ attachApp }) as never,
    installedHandlers: Object.freeze({}),
    listChanged: Object.freeze({ resources: false, tools: false }),
    onTrace: () => undefined,
    preview: Object.freeze({
      binding: Object.freeze({ id: 'runtime-binding', profileVersion: 'agent-bundle:mcp-apps:2026-01-26', sessionId: 'runtime-session-a', sessionRevision: 3 }),
      clientSurface: Object.freeze({ bootstrapUrl: 'https://apps.example.test/proxy', origin: 'https://apps.example.test', webSocketPath: '/rsbuild-hmr' as const }),
      documentPolicy: policy.snapshot,
      kind: 'apps' as const,
      profile: Object.freeze({ hostContext: Object.freeze({ availableDisplayModes: Object.freeze(['inline']), displayMode: 'inline', safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }), theme: 'light' }) }),
      resource: Object.freeze({ csp: Object.freeze({}), permissions: Object.freeze({}) }),
    }) as never,
    requestConsent: async () => 'deny',
    simulationFeatures: Object.freeze({ chatGptWidgetState: 'disabled' as const }),
  });
};

const invokeBridgeFactory = (factory: ReturnType<typeof createRuntimeAppBridgeFactory>, browser: ReturnType<typeof fakeBrowser>) =>
  factory(Object.freeze({ contentWindow: browser.target }) as never, Object.freeze({ name: 'weather' }) as never);

it('exposes the controller-owned official runtime App bridge boundary', () => {
  expect(typeof createBindingMcpClient).toBe('function');
  expect(typeof createRuntimeAppBridgeFactory).toBe('function');
});

it('forwards an initialized App tools/call through the controller-owned client transport', async () => {
  await withBrowser(async (browser) => {
    const policy = Object.freeze({
      bindingId: 'runtime-binding',
      snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
    });
    const received: unknown[] = [];
    const callResult = Object.freeze({
      content: Object.freeze([Object.freeze({ text: 'Timeline refreshed.', type: 'text' })]),
      structuredContent: Object.freeze({ edits: Object.freeze([]), stateVersion: 1 }),
    });
    const access = Object.freeze({
      client: Object.freeze({
        getServerCapabilities: () => Object.freeze({ resources: Object.freeze({}), tools: Object.freeze({}) }),
        request: async (request: Readonly<{ readonly method: string; readonly params?: unknown }>) => {
          received.push(Object.freeze({ method: request.method, params: request.params }));
          if (request.method !== 'tools/call') throw new Error(`Unexpected attached request ${request.method}.`);
          return callResult;
        },
        setNotificationHandler: () => undefined,
      }),
      close: async () => undefined,
      sessionId: 'runtime-session-a',
      sessionRevision: 3,
    });
    const factory = createRuntimeAppBridgeFactory({
      client: Object.freeze({
        closeRuntime: async () => undefined,
        currentDocumentPolicy: () => policy,
      }) as never,
      controller: Object.freeze({ attachApp: async () => access }) as never,
      installedHandlers: Object.freeze({}),
      listChanged: Object.freeze({ resources: false, tools: false }),
      onTrace: () => undefined,
      preview: Object.freeze({
        binding: Object.freeze({ id: 'runtime-binding', profileVersion: 'agent-bundle:mcp-apps:2026-01-26', sessionId: 'runtime-session-a', sessionRevision: 3 }),
        clientSurface: Object.freeze({ bootstrapUrl: 'https://apps.example.test/proxy', origin: 'https://apps.example.test', webSocketPath: '/rsbuild-hmr' as const }),
        documentPolicy: policy.snapshot,
        kind: 'apps' as const,
        profile: Object.freeze({ hostContext: Object.freeze({ availableDisplayModes: Object.freeze(['inline']), displayMode: 'inline', safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }), theme: 'light' }) }),
        resource: Object.freeze({ csp: Object.freeze({}), permissions: Object.freeze({}) }),
      }) as never,
      requestConsent: async () => 'deny',
      simulationFeatures: Object.freeze({ chatGptWidgetState: 'disabled' as const }),
    });
    const bridge = await invokeBridgeFactory(factory, browser);

    browser.emit({
      data: { id: 'initialize', jsonrpc: '2.0', method: 'ui/initialize', params: { appCapabilities: {}, appInfo: { name: 'app', version: '1' }, protocolVersion: '2026-01-26' } },
      origin: 'https://apps.example.test',
      source: browser.target,
    });
    await eventually(() => browser.posts.length === 1);
    browser.emit({
      data: { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} },
      origin: 'https://apps.example.test',
      source: browser.target,
    });
    browser.emit({
      data: { id: 'timeline-refresh', jsonrpc: '2.0', method: 'tools/call', params: { arguments: { limit: 10 }, name: 'render_edit_timeline' } },
      origin: 'https://apps.example.test',
      source: browser.target,
    });

    await eventually(() => received.length === 1);
    expect(received).toEqual([{
      method: 'tools/call',
      params: { arguments: { limit: 10 }, name: 'render_edit_timeline' },
    }]);
    await eventually(() => browser.posts.some((entry) => {
      const message = entry.message;
      return message !== null && typeof message === 'object' && (message as { readonly id?: unknown }).id === 'timeline-refresh';
    }));
    expect(browser.posts.find((entry) => {
      const message = entry.message;
      return message !== null && typeof message === 'object' && (message as { readonly id?: unknown }).id === 'timeline-refresh';
    })).toEqual({
      message: { id: 'timeline-refresh', jsonrpc: '2.0', result: callResult },
      targetOrigin: 'https://apps.example.test',
    });
    await bridge.close();
  });
});

it('closes admission before invocation and exposes one exact no-op factory cleanup promise', async () => {
  await withBrowser(async (browser) => {
    let attachments = 0;
    const factory = runtimeFactory(async () => {
      attachments += 1;
      return appAccess(async () => undefined);
    });
    const close = bridgeFactoryClose(factory);

    expect(typeof close).toBe('function');
    if (close === undefined) return;
    const first = close.call(factory);
    const second = close.call(factory);
    expect(second).toBe(first);
    await first;

    await expect(invokeBridgeFactory(factory, browser)).rejects.toThrow('closed');
    expect(attachments).toBe(0);
  });
});

it('joins a held attachment close and cleans its late controller access exactly once', async () => {
  await withBrowser(async (browser) => {
    const pending = deferred<ReturnType<typeof appAccess>>();
    let attachments = 0;
    let accessCloses = 0;
    const factory = runtimeFactory(async () => {
      attachments += 1;
      return pending.promise;
    });
    const opening = invokeBridgeFactory(factory, browser);
    const joinedOpening = invokeBridgeFactory(factory, browser);
    expect(joinedOpening).toBe(opening);
    await eventually(() => attachments === 1);
    const close = bridgeFactoryClose(factory);

    expect(typeof close).toBe('function');
    if (close === undefined) return;
    const closing = close.call(factory);
    pending.resolve(appAccess(async () => { accessCloses += 1; }));

    await expect(opening).rejects.toThrow('closed');
    await expect(closing).resolves.toBeUndefined();
    expect(accessCloses).toBe(1);
    await expect(invokeBridgeFactory(factory, browser)).rejects.toThrow('closed');
    expect(attachments).toBe(1);
  });
});

it('shares the returned bridge cleanup outcome with the callable factory and closes its access once', async () => {
  await withBrowser(async (browser) => {
    let accessCloses = 0;
    const factory = runtimeFactory(async () => appAccess(async () => { accessCloses += 1; }));
    const close = bridgeFactoryClose(factory);

    expect(typeof close).toBe('function');
    if (close === undefined) return;
    const bridge = await invokeBridgeFactory(factory, browser);
    const bridgeCleanup = bridge.close();
    const factoryCleanup = close.call(factory);
    const repeated = close.call(factory);

    expect(factoryCleanup).toBe(bridgeCleanup);
    expect(repeated).toBe(bridgeCleanup);
    await expect(factoryCleanup).resolves.toBeUndefined();
    expect(accessCloses).toBe(1);
  });
});

it('sends one bounded resource-teardown request and awaits an App acknowledgement', async () => {
  await withBrowser(async (browser) => {
    const factory = runtimeFactory(async () => appAccess(async () => undefined));
    const bridge = await invokeBridgeFactory(factory, browser);
    const teardown = bridge.teardownResource({});

    await eventually(() => browser.posts.some(({ message }) => (message as { readonly method?: unknown }).method === 'ui/resource-teardown'));
    const request = browser.posts.find(({ message }) => (message as { readonly method?: unknown }).method === 'ui/resource-teardown')!
      .message as { readonly id: string | number };
    expect(browser.posts.filter(({ message }) => (message as { readonly method?: unknown }).method === 'ui/resource-teardown')).toHaveLength(1);
    browser.emit({
      data: { id: request.id, jsonrpc: '2.0', result: {} },
      origin: 'https://apps.example.test',
      source: browser.target,
    });

    await expect(teardown).resolves.toEqual({});
    await factory.close();
  });
});

it('bounds an unresponsive resource-teardown before the factory releases transport and access', async () => {
  await withBrowser(async (browser) => {
    let accessCloses = 0;
    const factory = runtimeFactory(async () => appAccess(async () => { accessCloses += 1; }));
    const bridge = await invokeBridgeFactory(factory, browser);
    const started = Date.now();
    const teardown = bridge.teardownResource({});

    await eventually(() => browser.posts.some(({ message }) => (message as { readonly method?: unknown }).method === 'ui/resource-teardown'));
    expect(browser.posts.filter(({ message }) => (message as { readonly method?: unknown }).method === 'ui/resource-teardown')).toHaveLength(1);
    await expect(teardown).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_500);
    await expect(factory.close()).resolves.toBeUndefined();
    expect(accessCloses).toBe(1);
  });
});

it('maps all runtime App MCP operations through its binding executor, gates tool calls on consent, and emits only controller-validated public traces', async () => {
  const policy = Object.freeze({
    bindingId: 'runtime-binding',
    snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
  });
  let attachments = 0;
  let attached: McpSessionControllerAppAttachment | undefined;
  const operations: Array<Readonly<{ readonly bindingId: string; readonly operation: McpAppBindingOperation }>> = [];
  const consentRequests: unknown[] = [];
  const traces: unknown[] = [];
  let decision: 'allow-once' | 'deny' | 'error' = 'allow-once';
  const access = Object.freeze({
    client: Object.freeze({}),
    close: async () => undefined,
    sessionId: 'runtime-session-a',
    sessionRevision: 3,
  });
  const controller = {
    attachApp: async (candidate: McpSessionControllerAppAttachment) => {
      attachments += 1;
      attached = candidate;
      return access;
    },
  };
  const client = {
    createRuntimeConsent: async (bindingId: string, request: unknown) => {
      consentRequests.push(Object.freeze({ bindingId, request }));
      return Object.freeze({
        challenge: Object.freeze({ expiresAt: 10, id: 'consent-a', request: Object.freeze({}) }),
        documentPolicy: policy.snapshot,
      });
    },
    decideRuntimeConsent: async (_bindingId: string, _consentId: string, selected: 'allow-once' | 'deny') => {
      if (decision === 'error') throw new Error('consent decision failed');
      return Object.freeze({
        documentPolicy: policy.snapshot,
        grant: selected === 'allow-once' && decision === 'allow-once'
          ? Object.freeze({ authorizationId: 'authorization-a' })
          : undefined,
      });
    },
    currentDocumentPolicy: () => policy,
    operateRuntime: async (bindingId: string, operation: McpAppBindingOperation) => {
      operations.push(Object.freeze({ bindingId, operation }));
      return Object.freeze({
        operationId: `operation-${operations.length}`,
        sessionId: 'runtime-session-a',
        sessionRevision: 3,
        value: operation.kind === 'tools/list' ? Object.freeze([{ name: 'forecast' }]) : Object.freeze([]),
        vector: Object.freeze({ runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 2 }),
      });
    },
  };
  const preview = {
    binding: { id: 'runtime-binding', sessionId: 'runtime-session-a', sessionRevision: 3 },
    documentPolicy: { revision: 1 },
    kind: 'apps',
  };

  await expect(createBindingMcpClient(controller as never, client as never, preview as never, {
    onTrace: (entry: unknown) => traces.push(entry),
    requestConsent: async () => decision === 'error' ? 'allow-once' : decision,
  })).resolves.toBe(access);
  expect(attachments).toBe(1);
  if (attached === undefined) throw new Error('Expected one binding-scoped App attachment.');

  const tools = await attached.execute(Object.freeze({ kind: 'tools/list' }));
  await attached.execute(Object.freeze({ kind: 'resources/list' }));
  await attached.execute(Object.freeze({ kind: 'resources/read', uri: 'weather://today' }));
  await attached.execute(Object.freeze({ arguments: Object.freeze({ city: 'Paris' }), kind: 'tools/call', name: 'forecast' }));
  attached.onResult?.(Object.freeze({ kind: 'tools/list' }), tools);

  expect(operations).toEqual([
    { bindingId: 'runtime-binding', operation: { kind: 'tools/list' } },
    { bindingId: 'runtime-binding', operation: { kind: 'resources/list' } },
    { bindingId: 'runtime-binding', operation: { kind: 'resources/read', uri: 'weather://today' } },
    { bindingId: 'runtime-binding', operation: { arguments: { city: 'Paris' }, consentId: 'authorization-a', kind: 'tools/call', name: 'forecast' } },
  ]);
  expect(consentRequests).toEqual([expect.objectContaining({
    bindingId: 'runtime-binding',
    request: expect.objectContaining({ capability: 'call-tool', details: { arguments: { city: 'Paris' }, name: 'forecast' }, scope: 'action' }),
  })]);
  expect(traces).toEqual([{
    kind: 'tools/list',
    operationId: 'operation-1',
    sessionId: 'runtime-session-a',
    sessionRevision: 3,
    vector: { runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 2 },
  }]);
  expect(Object.isFrozen(traces[0])).toBe(true);
  expect(Object.isFrozen((traces[0] as Readonly<{ readonly vector: unknown }>).vector)).toBe(true);

  decision = 'deny';
  await expect(attached.execute(Object.freeze({ arguments: Object.freeze({ city: 'Rome' }), kind: 'tools/call', name: 'forecast' }))).rejects.toThrow('not approved');
  decision = 'error';
  await expect(attached.execute(Object.freeze({ arguments: Object.freeze({ city: 'Berlin' }), kind: 'tools/call', name: 'forecast' }))).rejects.toThrow('consent decision failed');
  expect(operations).toHaveLength(4);

  await expect(createBindingMcpClient(controller as never, client as never, {
    ...preview,
    binding: { ...preview.binding, sessionRevision: 4 },
  } as never, {
    onTrace: () => undefined,
    requestConsent: async () => 'deny',
  })).rejects.toThrow('session identity');
});

it('keeps a maximum valid App binding and large tool arguments out of the bounded consent fingerprint', async () => {
  const bindingId = 'b'.repeat(4_096);
  const argumentsValue = Object.freeze({ payload: 'x'.repeat(128 * 1024) });
  const policy = Object.freeze({
    bindingId,
    snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
  });
  let attached: McpSessionControllerAppAttachment | undefined;
  let decision: 'allow-once' | 'deny' = 'allow-once';
  const created: unknown[] = [];
  const decided: unknown[] = [];
  const operations: unknown[] = [];
  const access = Object.freeze({
    client: Object.freeze({}),
    close: async () => undefined,
    sessionId: 'runtime-session-a',
    sessionRevision: 3,
  });
  const controller = Object.freeze({
    attachApp: async (candidate: McpSessionControllerAppAttachment) => {
      attached = candidate;
      return access;
    },
  });
  const client = Object.freeze({
    createRuntimeConsent: async (_id: string, request: Readonly<{ readonly actionFingerprint?: unknown }>) => {
      if (typeof request.actionFingerprint !== 'string' || request.actionFingerprint.length > 256) {
        throw new Error('Runtime MCP App consent action fingerprint must be at most 256 characters.');
      }
      created.push(request);
      return Object.freeze({
        challenge: Object.freeze({ expiresAt: 10, id: 'consent-a', request: Object.freeze({}) }),
        documentPolicy: policy.snapshot,
      });
    },
    currentDocumentPolicy: () => policy,
    decideRuntimeConsent: async (_id: string, consentId: string, decision: 'allow-once' | 'deny') => {
      decided.push(Object.freeze({ consentId, decision }));
      return Object.freeze({
        documentPolicy: policy.snapshot,
        grant: decision === 'allow-once' ? Object.freeze({ authorizationId: 'authorization-large' }) : undefined,
      });
    },
    operateRuntime: async (_id: string, operation: McpAppBindingOperation) => {
      operations.push(operation);
      return Object.freeze({
        operationId: 'operation-large',
        sessionId: 'runtime-session-a',
        sessionRevision: 3,
        value: Object.freeze([]),
        vector: Object.freeze({ runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 2 }),
      });
    },
  });
  const preview = Object.freeze({
    binding: Object.freeze({ id: bindingId, sessionId: 'runtime-session-a', sessionRevision: 3 }),
    documentPolicy: policy.snapshot,
    kind: 'apps' as const,
  });

  await createBindingMcpClient(controller as never, client as never, preview as never, {
    onTrace: () => undefined,
    requestConsent: async () => decision,
  });
  if (attached === undefined) throw new Error('Expected one binding-scoped App attachment.');
  await attached.execute(Object.freeze({ arguments: argumentsValue, kind: 'tools/call', name: 'forecast' }));

  expect(created).toEqual([expect.objectContaining({
    actionFingerprint: 'runtime-app:call-tool:v1',
    details: { arguments: argumentsValue, name: 'forecast' },
  })]);
  expect(decided).toEqual([{ consentId: 'consent-a', decision: 'allow-once' }]);
  expect(operations).toEqual([{
    arguments: argumentsValue,
    consentId: 'authorization-large',
    kind: 'tools/call',
    name: 'forecast',
  }]);
  decision = 'deny';
  await expect(attached.execute(Object.freeze({ arguments: argumentsValue, kind: 'tools/call', name: 'forecast' }))).rejects.toThrow('not approved');
  expect(decided).toEqual([
    { consentId: 'consent-a', decision: 'allow-once' },
    { consentId: 'consent-a', decision: 'deny' },
  ]);
  expect(created).toHaveLength(2);
  expect(operations).toHaveLength(1);
});

it('closes the exact attachment once on bridge setup failure and leaves its retry to the controller owner', async () => {
  await withBrowser(async (browser) => {
    const policy = Object.freeze({
      bindingId: 'runtime-binding',
      snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
    });
    let attachments = 0;
    let attachmentCloses = 0;
    const access = Object.freeze({
      client: Object.freeze({
        getServerCapabilities: () => Object.freeze({}),
        request: async () => Object.freeze({}),
        setNotificationHandler: () => undefined,
      }),
      close: async () => {
        attachmentCloses += 1;
        if (attachmentCloses === 1) throw new Error('attached transport cleanup failed');
      },
      sessionId: 'runtime-session-a',
      sessionRevision: 3,
    });
    const factory = createRuntimeAppBridgeFactory({
      client: Object.freeze({
        closeRuntime: async () => undefined,
        currentDocumentPolicy: () => policy,
      }) as never,
      controller: Object.freeze({ attachApp: async () => {
        attachments += 1;
        return access;
      } }) as never,
      installedHandlers: Object.freeze({}),
      listChanged: Object.freeze({ resources: false, tools: false }),
      onTrace: () => undefined,
      preview: Object.freeze({
        binding: Object.freeze({ id: 'runtime-binding', profileVersion: 'agent-bundle:mcp-apps:2026-01-26', sessionId: 'runtime-session-a', sessionRevision: 3 }),
        clientSurface: Object.freeze({ bootstrapUrl: 'https://apps.example.test/proxy', origin: 'https://apps.example.test', webSocketPath: '/rsbuild-hmr' as const }),
        documentPolicy: policy.snapshot,
        kind: 'apps' as const,
        profile: Object.freeze({ hostContext: Object.freeze({ availableDisplayModes: Object.freeze(['inline']), displayMode: 'inline', safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }), theme: 'light' }) }),
        resource: Object.freeze({ csp: Object.freeze({}), permissions: Object.freeze({}) }),
      }) as never,
      requestConsent: async () => 'deny',
      simulationFeatures: Object.freeze({ chatGptWidgetState: 'disabled' as const }),
    });

    const opening = factory(Object.freeze({ contentWindow: browser.target }) as never, Object.freeze({ name: 'weather' }) as never);
    expect(factory(Object.freeze({ contentWindow: browser.target }) as never, Object.freeze({ name: 'weather' }) as never)).toBe(opening);
    await expect(opening).rejects.toThrow('setup failed and cleanup was incomplete');
    expect(attachmentCloses).toBe(1);
    expect(attachments).toBe(1);
    const cleanup = factory.close();
    expect(factory.close()).toBe(cleanup);
    await expect(cleanup).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'attached transport cleanup failed' })],
    });
    await expect(factory(Object.freeze({ contentWindow: browser.target }) as never, Object.freeze({ name: 'weather' }) as never)).rejects.toThrow('factory is closed');
    expect(attachments).toBe(1);
    await expect(access.close()).resolves.toBeUndefined();
    expect(attachmentCloses).toBe(2);
  }, { failMessageRegistration: true });
});

it('guards the official bridge to one source and origin while routing only tools and resources', async () => {
  await withBrowser(async (browser) => {
    const policy = Object.freeze({
      bindingId: 'runtime-binding',
      snapshot: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
    });
    const requests: string[] = [];
    let displayFallbackCalls = 0;
    let displayHandlerCalls = 0;
    let attachmentCloses = 0;
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
        createRuntimeConsent: async () => Object.freeze({
          challenge: Object.freeze({ id: 'display-consent' }),
        }),
        currentDocumentPolicy: () => policy,
        decideRuntimeConsent: async () => Object.freeze({ grant: Object.freeze({}) }),
      } as never,
      controller: {
        attachApp: async () => Object.freeze({
          client: attachedClient,
          close: async () => { attachmentCloses += 1; },
          sessionId: 'runtime-session-a',
          sessionRevision: 3,
        }),
      } as never,
      installedHandlers: Object.freeze({
        requestDisplayMode: async (mode: 'inline' | 'fullscreen') => {
          displayHandlerCalls += 1;
          return mode;
        },
      }),
      listChanged: Object.freeze({ resources: true, tools: true }),
      onTrace: () => undefined,
      preview: preview as never,
      requestConsent: async () => 'allow-once',
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

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullPrototype, '__proto__', { enumerable: true, value: 'literal-data' });
    await expect(bridge.sendToolInput({ arguments: nullPrototype } as never)).resolves.toBeUndefined();
    const accepted = browser.posts.at(-1) as { readonly message: { readonly params: { readonly arguments: unknown } } };
    expect(accepted.message.params.arguments).toBe(nullPrototype);

    const deep = (): unknown => {
      let value: unknown = Object.freeze({ leaf: true });
      for (let depth = 0; depth < 64; depth += 1) value = Object.freeze({ child: value });
      return value;
    };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const customPrototype = Object.create({ inherited: true });
    customPrototype.value = 'custom';
    const malformedValues: readonly unknown[] = [
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
    const validNotification = () => browser.emit({
      data: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      origin: 'https://apps.example.test',
      source: browser.target,
    });
    for (const nested of malformedValues) {
      await expect(bridge.sendToolInput({ arguments: { nested } } as never)).rejects.toThrow('invalid or exceeds its bound');
      validNotification();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(() => browser.emit({
        data: { jsonrpc: '2.0', method: 'notifications/initialized', params: { nested } },
        origin: 'https://apps.example.test',
        source: browser.target,
      })).not.toThrow();
      validNotification();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(revoked).toBe(0);

    const displayBridge = bridge as typeof bridge & {
      onrequestdisplaymode?: (params: Readonly<{ readonly mode: 'inline' | 'fullscreen' | 'pip' }>) => Promise<Readonly<{ readonly mode: 'inline' | 'fullscreen' | 'pip' }>>;
    };
    displayBridge.onrequestdisplaymode = async ({ mode }) => {
      displayFallbackCalls += 1;
      return { mode };
    };
    await expect(displayBridge.onrequestdisplaymode?.({ mode: 'pip' })).resolves.toEqual({ mode: 'inline' });
    expect(displayFallbackCalls).toBe(0);
    expect(displayHandlerCalls).toBe(0);
    await expect(displayBridge.onrequestdisplaymode?.({ mode: 'fullscreen' })).resolves.toEqual({ mode: 'fullscreen' });
    expect(displayFallbackCalls).toBe(1);
    expect(displayHandlerCalls).toBe(1);

    for (const [id, method] of [['tools', 'tools/list'], ['resources', 'resources/list'], ['templates', 'resources/templates/list'], ['prompts', 'prompts/list']] as const) {
      browser.emit({ data: { id, jsonrpc: '2.0', method, params: {} }, origin: 'https://apps.example.test', source: browser.target });
    }
    await eventually(() => requests.length === 2);
    expect(requests).toEqual(['tools/list', 'resources/list']);
    const nested = deep();
    browser.emit({
      data: { jsonrpc: '2.0', method: 'notifications/initialized', params: { nested } },
      origin: 'https://apps.example.test',
      source: browser.target,
    });
    browser.emit({
      data: { jsonrpc: '2.0', method: 'notifications/initialized', params: { nested } },
      origin: 'https://apps.example.test',
      source: browser.target,
    });
    browser.emit({
      data: { jsonrpc: '2.0', method: 'notifications/initialized', params: { nested } },
      origin: 'https://apps.example.test',
      source: browser.target,
    });
    await eventually(() => revoked === 1);
    const oversized = Object.freeze({ jsonrpc: '2.0', method: 'ping', payload: 'x'.repeat(256 * 1024) });
    browser.emit({ data: oversized, origin: 'https://apps.example.test', source: browser.target });
    browser.emit({ data: oversized, origin: 'https://apps.example.test', source: browser.target });
    browser.emit({ data: oversized, origin: 'https://apps.example.test', source: browser.target });
    await bridge.close();
    await bridge.close();
    expect(attachmentCloses).toBe(1);
  });
});
