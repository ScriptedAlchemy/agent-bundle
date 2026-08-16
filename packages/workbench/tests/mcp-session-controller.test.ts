import { expect, it } from '@rstest/core';
import type { Client, Transport } from '@modelcontextprotocol/client';

import {
  createMcpSessionController,
  type McpSessionControllerClient,
  type McpSessionControllerRoutes,
  type McpSessionControllerTransport,
} from '../src/mcp/mcp-session-controller.ts';
import type { McpRouteCatalog } from '../src/mcp/mcp-route-client.ts';

const binding = Object.freeze({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' as const });
const connection = Object.freeze({
  capabilities: { tools: {} },
  protocolEra: 'modern' as const,
  protocolVersion: '2025-11-25',
  server: { name: 'weather-fixture', version: '1.0.0' },
});

const runtimeSession = Object.freeze({
  binding: Object.freeze({
    definitionDigest: 'definition-a', registryRevision: 7, serverDigest: 'server-a', serverName: 'weather',
    sessionId: 'runtime-session-a', sessionRevision: 3, target: 'portable', transportDigest: 'transport-a',
  }),
  connection: Object.freeze({
    capabilities: Object.freeze({ resources: Object.freeze({ listChanged: true }), tools: Object.freeze({ listChanged: true }) }),
    protocolEra: 'modern' as const,
    protocolVersion: '2026-07-28',
    server: Object.freeze({ name: 'weather-runtime', version: '4.2.0' }),
  }),
  state: 'ready' as const,
});

const runtimeBinding = Object.freeze({ kind: 'runtime' as const, binding: runtimeSession.binding, session: runtimeSession });
const restartedRuntimeSession = Object.freeze({
  binding: Object.freeze({
    definitionDigest: 'definition-b', registryRevision: 8, serverDigest: 'server-b', serverName: 'weather',
    sessionId: 'runtime-session-a', sessionRevision: 4, target: 'portable', transportDigest: 'transport-b',
  }),
  connection: Object.freeze({
    capabilities: Object.freeze({ resources: Object.freeze({ listChanged: true }), tools: Object.freeze({ listChanged: true }) }),
    protocolEra: 'modern' as const,
    protocolVersion: '2026-02-09',
    server: Object.freeze({ name: 'weather-runtime-next', version: '5.0.0' }),
  }),
  state: 'ready' as const,
});
const unusedRuntimeRestart = Object.freeze({
  reconcile: Object.freeze({
    action: 'implementation-updated' as const,
    invalidatedBindings: Object.freeze([]),
    registryRevision: 7,
    restartedSessionIds: Object.freeze([]),
    runtimeGenerationId: 'generation-a',
    sequence: 1,
  }),
  session: runtimeSession,
});

const deferred = <Value>() => {
  let reject: (reason?: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const eventually = async (predicate: () => boolean, timeout = 300): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
};

const settledWithin = async <Value>(
  promise: Promise<Value>,
  timeout = 50,
): Promise<PromiseSettledResult<Value> | Readonly<{ readonly status: 'pending' }>> => Promise.race([
  promise.then<PromiseSettledResult<Value>, PromiseSettledResult<Value>>(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ reason, status: 'rejected' }),
  ),
  new Promise<Readonly<{ readonly status: 'pending' }>>((resolve) => {
    setTimeout(() => resolve({ status: 'pending' }), timeout);
  }),
]);

const traceStream = (): {
  readonly close: () => void;
  readonly response: Response;
  readonly send: (entry: unknown) => void;
} => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  return Object.freeze({
    close: () => controller?.close(),
    response,
    send: (entry) => controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(entry)}\n`)),
  });
};

const fakeTransport = (): McpSessionControllerTransport & { readonly events: string[] } => {
  const events: string[] = [];
  return {
    close: async () => { events.push('transport.close'); },
    events,
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
    start: async () => { events.push('transport.start'); },
  };
};

const fakeClient = (): McpSessionControllerClient & { readonly events: string[] } => {
  const events: string[] = [];
  return {
    close: async () => { events.push('client.close'); },
    connect: async (transport) => {
      events.push('client.connect');
      await transport.start();
    },
    events,
    request: async () => ({ content: [{ text: 'Rain' }] }),
  };
};

const emptyRoutes: McpSessionControllerRoutes = {
  catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
  config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
  restart: async () => connection,
  stream: async () => new Response(null),
  trace: async () => ({ entries: [] }),
};

it('connects the exact artifact binding then atomically publishes catalog and config while trace stays independently live', async () => {
  const catalog = deferred<McpRouteCatalog>();
  const config = deferred<unknown>();
  const stream = traceStream();
  const routes: McpSessionControllerRoutes = {
    catalog: async () => catalog.promise,
    config: async () => config.promise,
    restart: async () => connection,
    stream: async () => stream.response,
    trace: async () => ({
      entries: [{ kind: 'logging', occurredAt: 10, payload: { message: 'started' }, sequence: 1 }],
    }),
  };
  const transport = fakeTransport();
  const client = fakeClient();
  const controller = createMcpSessionController({
    clientFactory: () => client,
    routes,
    transportFactory: () => transport,
  });
  const observed: string[] = [];
  controller.subscribe((model) => observed.push(model.phase));

  const opening = controller.open(binding);
  await eventually(() => controller.model.phase === 'opening');
  expect(controller.model.catalogs).toEqual({ prompts: [], resourceTemplates: [], resources: [], tools: [] });
  expect(controller.model.config).toBeUndefined();
  expect(controller.model.timeline.entries).toEqual([
    { kind: 'logging', occurredAt: 10, payload: { message: 'started' }, sequence: 1 },
  ]);

  catalog.resolve({
    prompts: [{ name: 'weather' }],
    resourceTemplates: [{ uriTemplate: 'weather://{city}' }],
    resources: [{ uri: 'weather://today' }],
    tools: [{ name: 'forecast' }],
  });
  config.resolve({
    launch: { args: [], command: 'node', env: { TOKEN: 'secret', REGION: 'eu' }, kind: 'stdio' },
    origin: 'artifact',
  });
  await opening;

  expect(transport.events).toEqual(['transport.start']);
  expect(client.events).toEqual(['client.connect']);
  expect(observed).toEqual(['idle', 'opening', 'opening', 'opening', 'opening', 'ready']);
  expect(controller.model).toMatchObject({
    binding,
    catalogs: {
      prompts: [{ name: 'weather' }],
      resourceTemplates: [{ uriTemplate: 'weather://{city}' }],
      resources: [{ uri: 'weather://today' }],
      tools: [{ name: 'forecast' }],
    },
    config: { launch: { args: [], command: 'node', env: { REGION: 'eu', TOKEN: '[redacted]' }, kind: 'stdio' }, origin: 'artifact' },
    connection: { protocolVersion: '2025-11-25', serverInfo: { name: 'weather-fixture', version: '1.0.0' } },
    phase: 'ready',
  });
  expect(Object.isFrozen(controller.model)).toBe(true);

  stream.send({ direction: 'server', kind: 'progress', occurredAt: 11, payload: { progress: 1 }, sequence: 2 });
  await eventually(() => controller.model.timeline.lastSequence === 2);
  expect(controller.model.progress).toEqual([{ kind: 'progress', occurredAt: 11, payload: { progress: 1 }, sequence: 2 }]);

  stream.close();
  await controller.close();
});

it('attaches one non-owning runtime App client, routes only closed methods, and rejects a stale runtime response', async () => {
  const vector = Object.freeze({ providerSessionId: 'provider-a', runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateStoreId: 'store-a', stateVersion: 2 });
  const calls: string[] = [];
  let attachedTransport: Transport | undefined;
  const controller = createMcpSessionController({
    appClientFactory: () => ({
      close: async () => { calls.push('app-client.close'); },
      connect: async (transport: Transport) => { attachedTransport = transport; await transport.start(); },
      request: async () => undefined,
    }) as unknown as Client,
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async (request) => { calls.push(`runtime.close:${request.expectedSessionRevision}`); },
      config: async () => ({}),
      executeRuntime: async (_sessionId, request) => {
        calls.push(`runtime.execute:${request.kind}`);
        return { operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [{ name: 'forecast' }], vector };
      },
      openRuntime: async () => { throw new Error('Runtime App attachment must not open a new backend session.'); },
      restart: async () => connection,
      restartRuntime: async (request) => {
        calls.push(`runtime.restart:${request.expectedSessionRevision}`);
        return {
          reconcile: { action: 'sessions-restarted', invalidatedBindings: [{ sessionId: 'runtime-session-a', sessionRevision: 3 }], registryRevision: 8, restartedSessionIds: ['runtime-session-a'], runtimeGenerationId: 'generation-a', sequence: 1 },
          session: restartedRuntimeSession,
        };
      },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  const modelBinding = controller.model.binding;
  if (modelBinding === undefined || !('kind' in modelBinding) || modelBinding.kind !== 'runtime') {
    throw new Error('Expected the browser model to retain the runtime binding.');
  }
  expect(Object.hasOwn(modelBinding.binding, 'providerSessionId')).toBe(false);
  expect(Object.hasOwn(modelBinding.binding, 'stateStoreId')).toBe(false);
  const app = await controller.attachApp();
  const messages: unknown[] = [];
  if (attachedTransport === undefined) throw new Error('Expected controller-owned attached transport.');
  attachedTransport.onmessage = (message) => messages.push(message);
  await attachedTransport.send({ id: 0, jsonrpc: '2.0', method: 'initialize' });
  await attachedTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  await attachedTransport.send({ id: 2, jsonrpc: '2.0', method: 'prompts/list' });
  await expect(attachedTransport.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })).rejects.toThrow(
    'MCP remote transport received an invalid notification.',
  );

  expect(app).toMatchObject({ sessionId: 'runtime-session-a', sessionRevision: 3 });
  expect(messages).toEqual([
    { id: 0, jsonrpc: '2.0', result: { capabilities: { resources: { listChanged: true }, tools: { listChanged: true } }, protocolVersion: '2026-07-28', serverInfo: { name: 'weather-runtime', version: '4.2.0' } } },
    { id: 1, jsonrpc: '2.0', result: { tools: [{ name: 'forecast' }] } },
    { error: { code: -32601, message: 'MCP method "prompts/list" is not supported by the Agent Bundle remote transport.' }, id: 2, jsonrpc: '2.0' },
  ]);
  expect(calls).toEqual(['runtime.execute:list-tools']);
  expect(controller.history).toEqual([expect.objectContaining({ vector })]);

  await controller.restart();
  expect(controller.model).toMatchObject({
    binding: { kind: 'runtime', binding: restartedRuntimeSession.binding },
    connection: { protocolVersion: '2026-02-09', serverCapabilities: { resources: { listChanged: true }, tools: { listChanged: true } }, serverInfo: { name: 'weather-runtime-next', version: '5.0.0' } },
  });
  expect(calls).toEqual(['runtime.execute:list-tools', 'app-client.close', 'runtime.restart:3']);

  const replacement = await controller.attachApp();
  if (attachedTransport === undefined) throw new Error('Expected replacement runtime transport.');
  attachedTransport.onmessage = (message) => messages.push(message);
  await attachedTransport.send({ id: 3, jsonrpc: '2.0', method: 'initialize' });
  expect(replacement).toMatchObject({ sessionId: 'runtime-session-a', sessionRevision: 4 });
  expect(messages.at(-1)).toEqual({
    id: 3,
    jsonrpc: '2.0',
    result: {
      capabilities: { resources: { listChanged: true }, tools: { listChanged: true } },
      protocolVersion: '2026-02-09',
      serverInfo: { name: 'weather-runtime-next', version: '5.0.0' },
    },
  });

  await app.close();
  expect(calls).toEqual(['runtime.execute:list-tools', 'app-client.close', 'runtime.restart:3']);
  await controller.close();
  expect(calls).toEqual(['runtime.execute:list-tools', 'app-client.close', 'runtime.restart:3', 'app-client.close', 'runtime.close:4']);
});

it('rejects a mismatched runtime preview session before it can open or attach an SDK client', async () => {
  let appClientCreated = 0;
  const controller = createMcpSessionController({
    appClientFactory: () => {
      appClientCreated += 1;
      return {} as Client;
    },
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async () => { throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });
  const mismatched = Object.freeze({
    ...runtimeBinding,
    session: Object.freeze({
      ...runtimeSession,
      binding: Object.freeze({ ...runtimeSession.binding, sessionRevision: 4 }),
    }),
  });

  await expect(controller.open(mismatched)).rejects.toThrow('MCP session binding must contain only epochId, target, and serverName.');
  expect(appClientCreated).toBe(0);
  expect(controller.model.phase).toBe('idle');
});

it('serializes attached runtime App requests before admitting the next route operation', async () => {
  const first = deferred<Readonly<{ readonly operationId: string; readonly sessionId: string; readonly sessionRevision: number; readonly value: unknown; readonly vector: object }>>();
  const calls: string[] = [];
  let attachedTransport: Transport | undefined;
  const result = Object.freeze({
    operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [],
    vector: Object.freeze({ providerSessionId: 'provider-a', runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateStoreId: 'store-a', stateVersion: 2 }),
  });
  const controller = createMcpSessionController({
    appClientFactory: () => ({
      close: async () => undefined,
      connect: async (transport: Transport) => { attachedTransport = transport; await transport.start(); },
      request: async () => undefined,
    }) as unknown as Client,
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async (_sessionId, request) => {
        calls.push(request.kind);
        return calls.length === 1 ? first.promise as never : result as never;
      },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  await controller.attachApp();
  if (attachedTransport === undefined) throw new Error('Expected controller-owned attached transport.');
  const tools = attachedTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  await eventually(() => calls.length === 1);
  const resources = attachedTransport.send({ id: 2, jsonrpc: '2.0', method: 'resources/list' });
  await Promise.resolve();
  expect(calls).toEqual(['list-tools']);

  first.resolve(result);
  await Promise.all([tools, resources]);
  expect(calls).toEqual(['list-tools', 'list-resources']);
  await controller.close();
});

it('admits one runtime attachment, then clears only that closed attachment before a fresh reattach', async () => {
  const connected = deferred<void>();
  const clients: Client[] = [];
  let connects = 0;
  const controller = createMcpSessionController({
    appClientFactory: () => {
      const client = {
        close: async () => undefined,
        connect: async (next: Transport) => {
          connects += 1;
          await next.start();
          await connected.promise;
        },
        request: async () => undefined,
      } as unknown as Client;
      clients.push(client);
      return client;
    },
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async () => ({ operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [], vector: { providerSessionId: 'provider-a', runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateStoreId: 'store-a', stateVersion: 2 } }),
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  const first = controller.attachApp();
  const second = controller.attachApp();
  await eventually(() => connects === 1);
  connected.resolve();
  const [left, right] = await Promise.all([first, second]);

  expect(clients).toHaveLength(1);
  expect(left.client).toBe(right.client);
  await left.close();
  const fresh = await controller.attachApp();
  expect(clients).toHaveLength(2);
  expect(fresh.client).not.toBe(left.client);
  await controller.close();
});

it('retains a failed attached cleanup until controller close retries that exact attachment', async () => {
  const firstFailure = new Error('first attached client cleanup failed');
  const retryFailure = new Error('retry attached client cleanup failed');
  let appClients = 0;
  let closeAttempts = 0;
  const controller = createMcpSessionController({
    appClientFactory: () => {
      appClients += 1;
      return {
        close: async () => {
          closeAttempts += 1;
          throw closeAttempts === 1 ? firstFailure : retryFailure;
        },
        connect: async (transport: Transport) => transport.start(),
        request: async () => undefined,
      } as unknown as Client;
    },
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async () => ({ operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [], vector: { providerSessionId: 'provider-a', runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateStoreId: 'store-a', stateVersion: 2 } }),
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  const attached = await controller.attachApp();
  await expect(attached.close()).rejects.toBe(firstFailure);
  const retained = await controller.attachApp();
  expect(retained.client).toBe(attached.client);
  expect(appClients).toBe(1);

  await expect(controller.close()).rejects.toMatchObject({
    failures: [{ reason: retryFailure, resource: 'app-client' }],
  });
  expect(closeAttempts).toBe(2);
  expect(appClients).toBe(1);
});

it('drains an old runtime attachment across restart without publishing its stale result', async () => {
  const first = deferred<Readonly<{ readonly operationId: string; readonly sessionId: string; readonly sessionRevision: number; readonly value: unknown; readonly vector: object }>>();
  const transports: Transport[] = [];
  const closedClients: number[] = [];
  const requests: number[] = [];
  const controller = createMcpSessionController({
    appClientFactory: () => {
      const index = closedClients.length;
      closedClients.push(0);
      return {
        close: async () => { closedClients[index] += 1; },
        connect: async (transport: Transport) => { transports.push(transport); await transport.start(); },
        request: async () => undefined,
      } as unknown as Client;
    },
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async (_sessionId, request) => {
        requests.push(request.expectedSessionRevision);
        return requests.length === 1 ? first.promise as never : {
          operationId: 'operation-2', sessionId: 'runtime-session-a', sessionRevision: 4, value: [{ name: 'fresh' }],
          vector: { providerSessionId: 'provider-a', runtimeGenerationId: 'generation-b', sourceRevision: 'source-b', stateStoreId: 'store-a', stateVersion: 3 },
        } as never;
      },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => Object.freeze({
        reconcile: Object.freeze({
          action: 'sessions-restarted' as const,
          invalidatedBindings: Object.freeze([{ sessionId: 'runtime-session-a', sessionRevision: 3 }]),
          registryRevision: 8,
          restartedSessionIds: Object.freeze(['runtime-session-a']),
          runtimeGenerationId: 'generation-b',
          sequence: 1,
        }),
        session: restartedRuntimeSession,
      }),
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  const old = await controller.attachApp();
  const oldTransport = transports[0];
  if (oldTransport === undefined) throw new Error('Expected first runtime attachment.');
  const oldMessages: unknown[] = [];
  oldTransport.onmessage = (message) => oldMessages.push(message);
  const oldOperation = oldTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  await eventually(() => requests.length === 1);
  const restarting = controller.restart();
  first.resolve({ operationId: 'operation-1', sessionId: 'runtime-session-a', sessionRevision: 3, value: [{ name: 'stale' }], vector: { providerSessionId: 'provider-a', runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateStoreId: 'store-a', stateVersion: 2 } });
  await Promise.all([oldOperation, restarting]);

  expect(oldMessages).toEqual([]);
  expect(closedClients).toEqual([1]);
  expect(controller.history).toEqual([]);
  const fresh = await controller.attachApp();
  const freshTransport = transports[1];
  if (freshTransport === undefined) throw new Error('Expected replacement runtime attachment.');
  await freshTransport.send({ id: 2, jsonrpc: '2.0', method: 'tools/list' });
  expect(fresh.sessionRevision).toBe(4);
  expect(requests).toEqual([3, 4]);
  await controller.close();
  await old.close();
});

it('rejects command, path, and environment smuggling instead of widening the immutable binding', async () => {
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await expect(controller.open({ ...binding, command: 'sh', env: { TOKEN: 'leak' }, headers: { authorization: 'leak' }, path: '/tmp/other' } as typeof binding)).rejects.toThrow(
    'MCP session binding must contain only epochId, target, and serverName.',
  );
  expect(controller.model).toMatchObject({ phase: 'idle' });
});

it('rejects accessor, symbol, inherited, and trapped bindings without constructing a transport', async () => {
  let accessorReads = 0;
  const accessorBinding: Record<string, unknown> = Object.create(Object.prototype, {
    epochId: {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        Object.assign(accessorBinding, { command: 'sh', env: { TOKEN: 'leak' } });
        return binding.epochId;
      },
    },
    serverName: { enumerable: true, get: () => binding.serverName },
    target: { enumerable: true, get: () => binding.target },
  }) as Record<string, unknown>;
  const symbolBinding = Object.assign({ ...binding }, { [Symbol('command')]: 'sh' });
  const inheritedBinding = Object.assign(Object.create({ command: 'sh', env: { TOKEN: 'leak' } }), binding);
  const trappedBinding = new Proxy({ ...binding }, {
    getOwnPropertyDescriptor: () => { throw new Error('descriptor trap'); },
  });
  let transportCalls = 0;
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: () => {
      transportCalls += 1;
      return fakeTransport();
    },
  });

  for (const invalid of [accessorBinding, symbolBinding, inheritedBinding, trappedBinding]) {
    await expect(controller.open(invalid as typeof binding)).rejects.toThrow(
      'MCP session binding must contain only epochId, target, and serverName.',
    );
  }

  expect(accessorReads).toBe(0);
  expect(transportCalls).toBe(0);
  expect(controller.model.phase).toBe('idle');
  expect(controller.model.binding).toBeUndefined();
});

it('creates one detached frozen binding snapshot before a proxy can smuggle command and environment', async () => {
  const stream = traceStream();
  const supplied = { ...binding } as Record<string, unknown>;
  const descriptorReads: PropertyKey[] = [];
  const smugglingBinding = new Proxy(supplied, {
    getOwnPropertyDescriptor(target, key) {
      descriptorReads.push(key);
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === 'epochId') {
        Object.assign(target, { command: 'sh', env: { TOKEN: 'leak' }, epochId: 'epoch-mutated' });
      }
      return descriptor;
    },
  });
  let receivedBinding: unknown;
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => stream.response,
      trace: async () => ({ entries: [] }),
    },
    transportFactory: (options) => {
      receivedBinding = options.binding;
      return fakeTransport();
    },
  });

  await controller.open(smugglingBinding as typeof binding);

  expect(descriptorReads).toEqual(['epochId', 'serverName', 'target']);
  expect(receivedBinding).toEqual(binding);
  expect(Object.isFrozen(receivedBinding)).toBe(true);
  expect(controller.model.binding).toEqual(binding);
  expect(controller.model.binding).not.toHaveProperty('command');
  expect(controller.model.binding).not.toHaveProperty('env');
  stream.close();
  await controller.close();
});

it('turns a replay overflow into the inclusive replay-gap marker before applying later trace entries', async () => {
  const stream = traceStream();
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => stream.response,
      trace: async () => ({
        entries: [{ kind: 'logging', occurredAt: 7, payload: { message: 'resumed' }, sequence: 7 }],
        overflow: { afterSequence: 0, droppedThroughSequence: 6 },
      }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(binding);

  expect(controller.model.timeline).toEqual({
    droppedThroughSequence: 6,
    entries: [
      {
        earliestAvailableSequence: 7,
        latestDroppedSequence: 6,
        requestedAfterSequence: 0,
        type: 'replay.gap',
      },
      { kind: 'logging', occurredAt: 7, payload: { message: 'resumed' }, sequence: 7 },
    ],
    lastSequence: 7,
  });

  stream.close();
  await controller.close();
});

it('leaves the controller retryable when the transport factory throws before opening', async () => {
  const factoryFailure = new Error('transport factory failed');
  const stream = traceStream();
  let clientFactories = 0;
  let transportFactories = 0;
  const controller = createMcpSessionController({
    clientFactory: () => {
      clientFactories += 1;
      return fakeClient();
    },
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => stream.response,
      trace: async () => ({ entries: [] }),
    },
    transportFactory: () => {
      transportFactories += 1;
      if (transportFactories === 1) throw factoryFailure;
      return fakeTransport();
    },
  });

  await expect(controller.open(binding)).rejects.toThrow('transport factory failed');
  expect({ clientFactories, transportFactories }).toEqual({ clientFactories: 0, transportFactories: 1 });
  expect(controller.model.phase).toBe('idle');
  expect(controller.model.binding).toBeUndefined();

  await controller.open(binding);
  expect({ clientFactories, transportFactories }).toEqual({ clientFactories: 1, transportFactories: 2 });

  stream.close();
  await controller.close();
});

it('reports a client factory failure cleanup once and remains retryable', async () => {
  const cleanupFailure = new Error('transport cleanup failed');
  const factoryFailure = new Error('client factory failed');
  const stream = traceStream();
  let clientFactories = 0;
  let transportCloseCalls = 0;
  let transportFactories = 0;
  const controller = createMcpSessionController({
    clientFactory: () => {
      clientFactories += 1;
      if (clientFactories === 1) throw factoryFailure;
      return fakeClient();
    },
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => stream.response,
      trace: async () => ({ entries: [] }),
    },
    transportFactory: () => {
      transportFactories += 1;
      if (transportFactories > 1) return fakeTransport();
      return {
        ...fakeTransport(),
        close: async () => {
          transportCloseCalls += 1;
          throw cleanupFailure;
        },
      };
    },
  });

  const [firstOpening] = await Promise.allSettled([controller.open(binding)]);

  expect(firstOpening).toMatchObject({
    reason: {
      failures: [{ reason: cleanupFailure, resource: 'transport' }],
      message: 'MCP session controller failed: client factory failed. Cleanup failed for transport.',
      name: 'McpSessionControllerFailureError',
      primary: factoryFailure,
    },
    status: 'rejected',
  });
  expect(transportCloseCalls).toBe(1);
  expect(controller.model.phase).toBe('idle');
  expect(controller.model.binding).toBeUndefined();

  await controller.open(binding);
  expect({ clientFactories, transportFactories }).toEqual({ clientFactories: 2, transportFactories: 2 });

  stream.close();
  await controller.close();
});

const hostileConstructionReasons = [
  {
    createReason: () => ({ toString: () => { throw new Error('toString trap'); } }),
    name: 'throwing toString',
  },
  {
    createReason: () => ({ [Symbol.toPrimitive]: () => { throw new Error('primitive trap'); } }),
    name: 'throwing Symbol.toPrimitive',
  },
  {
    createReason: () => Object.defineProperty(new Error('hidden'), 'message', {
      get: () => { throw new Error('message trap'); },
    }),
    name: 'throwing Error.message access',
  },
  {
    createReason: () => new Proxy({}, {
      getPrototypeOf: () => { throw new Error('prototype trap'); },
    }),
    name: 'throwing prototype access',
  },
] as const;

for (const { createReason, name } of hostileConstructionReasons) {
  it(`settles construction and preserves a ${name} reason without blocking close`, async () => {
    const reason = createReason();
    const controller = createMcpSessionController({
      clientFactory: fakeClient,
      routes: emptyRoutes,
      transportFactory: () => { throw reason; },
    });

    const opening = controller.open(binding);
    const closing = controller.close();
    const [openingResult, closingResult] = await Promise.all([
      settledWithin(opening),
      settledWithin(closing),
    ]);

    expect(openingResult.status).toBe('rejected');
    if (openingResult.status !== 'rejected') throw new Error('Expected construction to reject.');
    const failure = openingResult.reason as Readonly<{
      readonly failures: readonly unknown[];
      readonly message: string;
      readonly name: string;
      readonly primary: unknown;
    }>;
    expect(failure.primary === reason).toBe(true);
    expect(failure.failures).toEqual([]);
    expect(failure.message).toBe('MCP session controller failed: Unknown error.');
    expect(failure.name).toBe('McpSessionControllerFailureError');
    expect(closingResult).toEqual({ status: 'fulfilled', value: undefined });
    expect(controller.model.phase).toBe('closed');
  });
}

const constructionCleanupReentries = [
  { async: false, name: 'returns controller.close()' },
  { async: true, name: 'awaits controller.close()' },
] as const;

for (const cleanup of constructionCleanupReentries) {
  it(`does not deadlock when construction cleanup ${cleanup.name}`, async () => {
    const factoryFailure = new Error('client factory failed');
    let cleanupCalls = 0;
    const controller = createMcpSessionController({
      clientFactory: () => { throw factoryFailure; },
      routes: emptyRoutes,
      transportFactory: () => transport,
    });
    const transport = fakeTransport();
    transport.close = cleanup.async
      ? async () => {
          cleanupCalls += 1;
          await controller.close();
        }
      : () => {
          cleanupCalls += 1;
          return controller.close();
        };

    const openingResult = await settledWithin(controller.open(binding));

    expect(openingResult).toMatchObject({
      reason: {
        failures: [],
        name: 'McpSessionControllerFailureError',
        primary: factoryFailure,
      },
      status: 'rejected',
    });
    expect(cleanupCalls).toBe(1);
    expect(controller.model.phase).toBe('idle');
    await expect(controller.close()).resolves.toBeUndefined();
  });
}

it('keeps an external close pending behind gated construction cleanup and runs cleanup once', async () => {
  const cleanupGate = deferred<void>();
  const factoryFailure = new Error('client factory failed');
  let cleanupCalls = 0;
  const transport = fakeTransport();
  transport.close = async () => {
    cleanupCalls += 1;
    await cleanupGate.promise;
  };
  const controller = createMcpSessionController({
    clientFactory: () => { throw factoryFailure; },
    routes: emptyRoutes,
    transportFactory: () => transport,
  });

  const opening = controller.open(binding);
  await eventually(() => cleanupCalls === 1);
  const closing = controller.close();
  expect(controller.close()).toBe(closing);
  expect(await settledWithin(closing)).toEqual({ status: 'pending' });
  expect(cleanupCalls).toBe(1);

  cleanupGate.resolve();
  await expect(opening).rejects.toMatchObject({ primary: factoryFailure });
  await expect(closing).resolves.toBeUndefined();
  expect(cleanupCalls).toBe(1);
  expect(controller.model.phase).toBe('closed');
});

it('does not extend the construction drain across an in-flight client connection', async () => {
  const connectGate = deferred<void>();
  const events: string[] = [];
  const transport = fakeTransport();
  transport.close = async () => { events.push('transport.close'); };
  const controller = createMcpSessionController({
    clientFactory: () => ({
      close: async () => { events.push('client.close'); },
      connect: async () => {
        events.push('client.connect');
        await connectGate.promise;
      },
      request: async () => undefined,
    }),
    routes: emptyRoutes,
    transportFactory: () => transport,
  });

  const opening = controller.open(binding);
  await eventually(() => events.includes('client.connect'));
  const closing = controller.close();

  expect(await settledWithin(closing)).toEqual({ status: 'fulfilled', value: undefined });
  expect(await settledWithin(opening)).toEqual({ status: 'pending' });
  expect(events).toEqual(['client.connect', 'client.close', 'transport.close']);

  connectGate.resolve();
  await expect(opening).resolves.toMatchObject({ phase: 'closed' });
});

it('closes a transport returned after its factory closes admission without reviving the controller', async () => {
  const closeGate = deferred<void>();
  const events: string[] = [];
  let clientFactories = 0;
  let closeFromFactory: Promise<void> | undefined;
  let closeSettled = false;
  let openingSettled = false;
  const transport: McpSessionControllerTransport = {
    close: async () => {
      events.push('transport.close');
      await closeGate.promise;
    },
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
    start: async () => undefined,
  };
  const controller = createMcpSessionController({
    clientFactory: () => {
      clientFactories += 1;
      return fakeClient();
    },
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: () => {
      closeFromFactory = controller.close();
      return transport;
    },
  });

  const openingPromise = controller.open(binding);
  if (closeFromFactory === undefined) throw new Error('Expected transport factory to close the controller.');
  void openingPromise.then(() => { openingSettled = true; }, () => { openingSettled = true; });
  void closeFromFactory.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  await eventually(() => events.includes('transport.close'));

  expect(closeSettled).toBe(false);
  expect(openingSettled).toBe(false);

  closeGate.resolve();
  const [opening] = await Promise.allSettled([openingPromise]);
  await expect(closeFromFactory).resolves.toBeUndefined();

  expect(opening).toMatchObject({
    reason: {
      failures: [],
      message: 'MCP session controller failed: MCP session controller was closed while opening.',
      name: 'McpSessionControllerFailureError',
    },
    status: 'rejected',
  });
  expect(clientFactories).toBe(0);
  expect(events).toEqual(['transport.close']);
  expect(controller.close()).toBe(closeFromFactory);
  expect(controller.model.phase).toBe('closed');
  expect(controller.model.binding).toBeUndefined();
  expect(controller.session).toBeUndefined();
  await expect(controller.open(binding)).rejects.toThrow('MCP session controller is already open.');
});

it('retains local client and transport cleanup failures when a client factory closes admission', async () => {
  const clientCloseFailure = new Error('client cleanup failed');
  const clientCloseGate = deferred<void>();
  const transportCloseFailure = new Error('transport cleanup failed');
  const events: string[] = [];
  let closeFromFactory: Promise<void> | undefined;
  let closeSettled = false;
  let openingSettled = false;
  const transport: McpSessionControllerTransport = {
    close: async () => {
      events.push('transport.close');
      throw transportCloseFailure;
    },
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
    start: async () => undefined,
  };
  const client: McpSessionControllerClient = {
    close: async () => {
      events.push('client.close');
      await clientCloseGate.promise;
      throw clientCloseFailure;
    },
    connect: async () => undefined,
    request: async () => undefined,
  };
  const controller = createMcpSessionController({
    clientFactory: () => {
      closeFromFactory = controller.close();
      return client;
    },
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: () => transport,
  });

  const openingPromise = controller.open(binding);
  if (closeFromFactory === undefined) throw new Error('Expected client factory to close the controller.');
  void openingPromise.then(() => { openingSettled = true; }, () => { openingSettled = true; });
  void closeFromFactory.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  await eventually(() => events.length === 2);

  expect(closeSettled).toBe(false);
  expect(openingSettled).toBe(false);

  clientCloseGate.resolve();
  const [opening] = await Promise.allSettled([openingPromise]);
  await expect(closeFromFactory).resolves.toBeUndefined();

  expect(opening).toMatchObject({
    reason: {
      failures: [
        { reason: clientCloseFailure, resource: 'client' },
        { reason: transportCloseFailure, resource: 'transport' },
      ],
      message: 'MCP session controller failed: MCP session controller was closed while opening. Cleanup failed for client, transport.',
      name: 'McpSessionControllerFailureError',
    },
    status: 'rejected',
  });
  expect(events).toEqual(['client.close', 'transport.close']);
  expect(controller.close()).toBe(closeFromFactory);
  expect(controller.model.phase).toBe('closed');
  expect(controller.model.binding).toBeUndefined();
  expect(controller.session).toBeUndefined();
  await expect(controller.open(binding)).rejects.toThrow('MCP session controller is already open.');
});

it('threads the admitted timeout through open while keeping it outside the immutable binding', async () => {
  const stream = traceStream();
  let received: unknown;
  const transport: McpSessionControllerTransport = {
    close: async () => undefined,
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 12_345 }),
    start: async () => undefined,
  };
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => stream.response,
      trace: async () => ({ entries: [] }),
    },
    transportFactory: (options) => {
      received = options;
      return transport;
    },
  });

  await controller.open(binding, 12_345);

  expect(received).toMatchObject({ binding, timeoutMs: 12_345 });
  expect(controller.session?.timeoutMs).toBe(12_345);
  expect(controller.model.binding).toEqual(binding);
  expect('timeoutMs' in (controller.model.binding ?? {})).toBe(false);

  stream.close();
  await controller.close();
});

it('replays only the recorded epoch binding and carries replay provenance into immutable history', async () => {
  const stream = traceStream();
  const requests: unknown[] = [];
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [{ name: 'forecast' }] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async () => stream.response,
    trace: async () => ({ entries: [] }),
  };
  const client: McpSessionControllerClient = {
    close: async () => undefined,
    connect: async (transport) => transport.start(),
    request: async (request) => {
      requests.push(request);
      return { content: [{ text: 'Rain' }] };
    },
  };
  const controller = createMcpSessionController({
    clientFactory: () => client,
    routes,
    transportFactory: () => fakeTransport(),
  });
  await controller.open(binding);

  await controller.invoke({
    id: 'call-1',
    operation: 'callTool',
    request: { arguments: { city: 'London' }, name: 'forecast' },
  });
  await controller.replay({ id: 'call-2', invocationId: 'call-1' });

  expect(requests).toEqual([
    { method: 'tools/call', params: { arguments: { city: 'London' }, name: 'forecast' } },
    { method: 'tools/call', params: { arguments: { city: 'London' }, name: 'forecast' } },
  ]);
  expect(controller.history).toEqual([
    expect.objectContaining({
      binding,
      id: 'call-1',
      operation: 'callTool',
      request: { arguments: { city: 'London' }, name: 'forecast' },
    }),
    expect.objectContaining({ binding, id: 'call-2', operation: 'callTool', replayOf: 'call-1' }),
  ]);

  await expect(controller.replay({ id: 'call-3', invocationId: 'missing' })).rejects.toThrow(
    'MCP invocation "missing" is not available for replay.',
  );
  expect(controller.model.diagnostics).toContainEqual({
    code: 'mcp.replay.unavailable',
    message: 'MCP invocation "missing" is not available for replay.',
    severity: 'error',
  });

  stream.close();
  await controller.close();
});

it('surfaces unsupported client operations as one stable controller diagnostic rather than hanging', async () => {
  const stream = traceStream();
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async () => stream.response,
    trace: async () => ({ entries: [] }),
  };
  const controller = createMcpSessionController({ clientFactory: fakeClient, routes, transportFactory: fakeTransport });
  await controller.open(binding);

  await expect(controller.invoke({ id: 'unsupported-1', operation: 'roots/list' as 'listTools', request: {} })).rejects.toThrow(
    'MCP operation "roots/list" is not supported by the session controller.',
  );
  expect(controller.model.diagnostics).toEqual([{
    code: 'mcp.operation.unsupported',
    message: 'MCP operation "roots/list" is not supported by the session controller.',
    severity: 'error',
  }]);

  stream.close();
  await controller.close();
});

it('cancels active SDK work through its transport signal and closes trace before client and transport', async () => {
  const stream = traceStream();
  const events: string[] = [];
  const pending = deferred<unknown>();
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async (_id, _after, signal) => {
      signal?.addEventListener('abort', () => {
        events.push('trace.abort');
        stream.close();
      }, { once: true });
      return stream.response;
    },
    trace: async () => ({ entries: [] }),
  };
  const transport: McpSessionControllerTransport = {
    close: async () => { events.push('transport.close'); },
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
    start: async () => undefined,
  };
  const client: McpSessionControllerClient = {
    close: async () => { events.push('client.close'); },
    connect: async (next) => next.start(),
    request: async (_request, options) => new Promise<unknown>((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        events.push('request.abort');
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
      void pending.promise.then(resolve, reject);
    }),
  };
  const controller = createMcpSessionController({ clientFactory: () => client, routes, transportFactory: () => transport });
  await controller.open(binding);

  const request = controller.invoke({ id: 'tools-1', operation: 'listTools', request: {} });
  await eventually(() => controller.model.activeRequests['tools-1'] !== undefined);
  expect(controller.cancel('tools-1')).toBe(true);
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(events).toEqual(['request.abort']);

  await controller.close();
  expect(events).toEqual(['request.abort', 'trace.abort', 'client.close', 'transport.close']);
  expect(controller.model).toMatchObject({ activeRequests: {}, phase: 'closed' });
});

it('fails an active session when its transport reports a real fault during a request', async () => {
  const stream = traceStream();
  const events: string[] = [];
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async (_id, _after, signal) => {
      signal?.addEventListener('abort', () => {
        events.push('trace.abort');
        stream.close();
      }, { once: true });
      return stream.response;
    },
    trace: async () => ({ entries: [] }),
  };
  const transport: McpSessionControllerTransport & { readonly events: string[] } = {
    close: async () => { events.push('transport.close'); },
    events,
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
    start: async () => undefined,
  };
  const client: McpSessionControllerClient = {
    close: async () => { events.push('client.close'); },
    connect: async (next) => next.start(),
    request: async (_request, options) => new Promise<unknown>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        events.push('request.abort');
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }),
  };
  const controller = createMcpSessionController({ clientFactory: () => client, routes, transportFactory: () => transport });
  await controller.open(binding);

  const request = controller.invoke({ id: 'tools-1', operation: 'listTools', request: {} });
  await eventually(() => controller.model.activeRequests['tools-1'] !== undefined);
  transport.onerror?.(new Error('MCP socket disconnected.'));

  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await eventually(() => controller.model.phase === 'error');
  expect(controller.model.diagnostics).toContainEqual({
    code: 'mcp.transport.error',
    message: 'MCP session controller failed: MCP socket disconnected..',
    severity: 'error',
  });
  expect(events).toEqual(['trace.abort', 'request.abort', 'client.close', 'transport.close']);
});

it('preserves binding, trace, and history through restart while refreshing connection and catalogs', async () => {
  const stream = traceStream();
  let catalogCount = 0;
  const restarted = Object.freeze({
    capabilities: { prompts: {} },
    protocolEra: 'modern' as const,
    protocolVersion: '2026-01-26',
    server: { name: 'weather-fixture', version: '2.0.0' },
  });
  const routes: McpSessionControllerRoutes = {
    catalog: async () => {
      catalogCount += 1;
      return { prompts: [{ name: catalogCount === 1 ? 'weather' : 'alerts' }], resourceTemplates: [], resources: [], tools: [] };
    },
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => restarted,
    stream: async () => stream.response,
    trace: async (_id, after) => ({ entries: after === 0
      ? [{ direction: 'server', kind: 'logging', occurredAt: 1, payload: { message: 'first' }, sequence: 1 }]
      : [{ direction: 'server', kind: 'logging', occurredAt: 2, payload: { message: 'restart' }, sequence: 2 }],
    }),
  };
  const client = fakeClient();
  const transport = fakeTransport();
  const controller = createMcpSessionController({ clientFactory: () => client, routes, transportFactory: () => transport });
  await controller.open(binding);
  await controller.invoke({ id: 'prompts-1', operation: 'listPrompts', request: {} });

  await controller.restart();

  expect(controller.model).toMatchObject({
    binding,
    catalogs: { prompts: [{ name: 'alerts' }] },
    connection: { protocolVersion: '2026-01-26', serverInfo: { name: 'weather-fixture', version: '2.0.0' } },
    phase: 'ready',
  });
  expect(controller.history).toEqual([expect.objectContaining({ binding, id: 'prompts-1', operation: 'listPrompts' })]);
  expect(controller.model.logs).toEqual([
    { kind: 'logging', occurredAt: 1, payload: { message: 'first' }, sequence: 1 },
    { kind: 'logging', occurredAt: 2, payload: { message: 'restart' }, sequence: 2 },
  ]);
  expect(client.events).toEqual(['client.connect']);
  expect(transport.events).toEqual(['transport.start']);

  stream.close();
  await controller.close();
});

it('reports a terminal trace stream EOF as an explicit controller error instead of silently hanging', async () => {
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
    trace: async () => ({ entries: [] }),
  };
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes,
    transportFactory: fakeTransport,
  });

  await controller.open(binding);
  await eventually(() => controller.model.phase === 'error');

  expect(controller.model.diagnostics).toEqual([{
    code: 'mcp.trace.stream.closed',
    message: 'Foreground MCP trace stream closed unexpectedly.',
    severity: 'error',
  }]);
  await controller.close();
});

it('admits one opening session and disposes that exact client and transport when connection fails', async () => {
  const connecting = deferred<void>();
  const events: string[] = [];
  let clients = 0;
  let transports = 0;
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async () => new Response(null),
    trace: async () => ({ entries: [] }),
  };
  const controller = createMcpSessionController({
    clientFactory: () => {
      clients += 1;
      if (clients > 1) throw new Error('A second client must not be created.');
      return {
        close: async () => { events.push('client.close'); },
        connect: async () => connecting.promise,
        request: async () => undefined,
      };
    },
    routes,
    transportFactory: () => {
      transports += 1;
      if (transports > 1) throw new Error('A second transport must not be created.');
      return {
        close: async () => { events.push('transport.close'); },
        send: async () => undefined,
        session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
        start: async () => undefined,
      };
    },
  });

  const opening = controller.open(binding);
  await expect(controller.open(binding)).rejects.toThrow('MCP session controller is already open.');
  expect({ clients, transports }).toEqual({ clients: 1, transports: 1 });

  connecting.reject(new Error('connect failed'));
  await expect(opening).rejects.toThrow('connect failed');
  expect(events).toEqual(['client.close', 'transport.close']);
});

it('retains a failed connection and both cleanup failures for every subsequent close', async () => {
  const primaryFailure = new Error('connect failed');
  const clientCloseFailure = new Error('client DELETE failed');
  const transportCloseFailure = new Error('transport DELETE failed');
  const events: string[] = [];
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async () => new Response(null),
    trace: async () => ({ entries: [] }),
  };
  const controller = createMcpSessionController({
    clientFactory: () => ({
      close: async () => {
        events.push('client.close');
        throw clientCloseFailure;
      },
      connect: async () => { throw primaryFailure; },
      request: async () => undefined,
    }),
    routes,
    transportFactory: () => ({
      close: async () => {
        events.push('transport.close');
        throw transportCloseFailure;
      },
      send: async () => undefined,
      session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
      start: async () => undefined,
    }),
  });

  const [opening] = await Promise.allSettled([controller.open(binding)]);
  const [closing] = await Promise.allSettled([controller.close()]);
  expect(opening.status).toBe('rejected');
  expect(closing.status).toBe('rejected');
  if (opening.status !== 'rejected' || closing.status !== 'rejected') throw new Error('Expected failed connection and close.');
  expect(closing.reason).toBe(opening.reason);
  expect(opening.reason).toMatchObject({
    failures: [
      { reason: clientCloseFailure, resource: 'client' },
      { reason: transportCloseFailure, resource: 'transport' },
    ],
    message: 'MCP session controller failed: connect failed. Cleanup failed for client, transport.',
    name: 'McpSessionControllerFailureError',
    primary: primaryFailure,
  });
  const failure = opening.reason as Readonly<{ readonly failures: readonly object[] }>;
  expect(Object.isFrozen(opening.reason)).toBe(true);
  expect(Object.isFrozen(failure.failures)).toBe(true);
  expect(failure.failures.every(Object.isFrozen)).toBe(true);
  expect(events).toEqual(['client.close', 'transport.close']);
  expect(controller.model).toMatchObject({
    diagnostics: [{
      code: 'mcp.connect.failed',
      message: 'MCP session controller failed: connect failed. Cleanup failed for client, transport.',
      severity: 'error',
    }],
    phase: 'error',
  });
});

it('rejects a concurrent restart so a late result cannot overwrite the admitted refresh', async () => {
  const stream = traceStream();
  const firstRestart = deferred<typeof connection>();
  let restartCalls = 0;
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => {
      restartCalls += 1;
      return restartCalls === 1 ? firstRestart.promise : connection;
    },
    stream: async () => stream.response,
    trace: async () => ({ entries: [] }),
  };
  const controller = createMcpSessionController({ clientFactory: fakeClient, routes, transportFactory: fakeTransport });
  await controller.open(binding);

  const restarting = controller.restart();
  await eventually(() => restartCalls === 1);
  await expect(controller.restart()).rejects.toThrow('MCP session controller is restarting.');
  expect(restartCalls).toBe(1);

  firstRestart.resolve(connection);
  await restarting;
  expect(controller.model.phase).toBe('ready');

  stream.close();
  await controller.close();
});

it('gates post-close operations before their routes or client calls and drains active request and trace work first', async () => {
  const releaseRequest = deferred<void>();
  const stream = traceStream();
  const events: string[] = [];
  let requestCalls = 0;
  let restartCalls = 0;
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => {
      restartCalls += 1;
      return connection;
    },
    stream: async (_id, _after, signal) => {
      signal?.addEventListener('abort', () => {
        events.push('trace.abort');
        stream.close();
      }, { once: true });
      return stream.response;
    },
    trace: async () => ({ entries: [] }),
  };
  const transport: McpSessionControllerTransport = {
    close: async () => { events.push('transport.close'); },
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
    start: async () => undefined,
  };
  const client: McpSessionControllerClient = {
    close: async () => { events.push('client.close'); },
    connect: async (next) => next.start(),
    request: async (_request, options) => {
      requestCalls += 1;
      if (requestCalls > 1) throw new Error('A post-close client call must not occur.');
      return new Promise<unknown>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          events.push('request.abort');
          void releaseRequest.promise.then(() => reject(new DOMException('Aborted', 'AbortError')));
        }, { once: true });
      });
    },
  };
  const controller = createMcpSessionController({ clientFactory: () => client, routes, transportFactory: () => transport });
  await controller.open(binding);
  const active = controller.invoke({ id: 'active-1', operation: 'listTools', request: {} });
  await eventually(() => controller.model.activeRequests['active-1'] !== undefined);

  const closing = controller.close();
  await eventually(() => events.includes('request.abort') && events.includes('trace.abort'));
  await expect(controller.invoke({ id: 'late-1', operation: 'listTools', request: {} })).rejects.toThrow('MCP session controller is closing.');
  await expect(controller.restart()).rejects.toThrow('MCP session controller is closing.');
  await expect(controller.open(binding)).rejects.toThrow('MCP session controller is closing.');
  expect({ requestCalls, restartCalls }).toEqual({ requestCalls: 1, restartCalls: 0 });
  expect(events).toEqual(['trace.abort', 'request.abort']);

  releaseRequest.resolve();
  await expect(active).rejects.toMatchObject({ name: 'AbortError' });
  await closing;
  expect(events).toEqual(['trace.abort', 'request.abort', 'client.close', 'transport.close']);
});

it('buffers live trace frames until a delayed restart snapshot supplies the missing cursor', async () => {
  const stream = traceStream();
  const delayedSnapshot = deferred<Readonly<{ readonly entries: readonly unknown[] }>>();
  let traceCalls = 0;
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async () => stream.response,
    trace: async (_id, after) => {
      traceCalls += 1;
      return after === 0
        ? { entries: [{ kind: 'logging', occurredAt: 1, payload: { message: 'one' }, sequence: 1 }] }
        : delayedSnapshot.promise;
    },
  };
  const controller = createMcpSessionController({ clientFactory: fakeClient, routes, transportFactory: fakeTransport });
  await controller.open(binding);

  const restarting = controller.restart();
  await eventually(() => traceCalls === 2);
  stream.send({ kind: 'logging', occurredAt: 3, payload: { message: 'three' }, sequence: 3 });
  delayedSnapshot.resolve({ entries: [{ kind: 'logging', occurredAt: 2, payload: { message: 'two' }, sequence: 2 }] });
  await restarting;

  expect(controller.model.logs).toEqual([
    { kind: 'logging', occurredAt: 1, payload: { message: 'one' }, sequence: 1 },
    { kind: 'logging', occurredAt: 2, payload: { message: 'two' }, sequence: 2 },
    { kind: 'logging', occurredAt: 3, payload: { message: 'three' }, sequence: 3 },
  ]);
  expect(controller.model.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'mcp.trace.gap-required' }));

  stream.close();
  await controller.close();
});

it('rejects one shared close outcome after every delayed resource cleanup is attempted', async () => {
  const releaseRequest = deferred<void>();
  const releaseClient = deferred<void>();
  const releaseTransport = deferred<void>();
  const stream = traceStream();
  const events: string[] = [];
  const clientCloseFailure = new Error('client DELETE failed');
  const transportCloseFailure = new Error('transport DELETE failed');
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async (_id, _after, signal) => {
      signal?.addEventListener('abort', () => {
        events.push('trace.abort');
        stream.close();
      }, { once: true });
      return stream.response;
    },
    trace: async () => ({ entries: [] }),
  };
  const transport: McpSessionControllerTransport = {
    close: async () => {
      events.push('transport.close.start');
      await releaseTransport.promise;
      events.push('transport.close.reject');
      throw transportCloseFailure;
    },
    send: async () => undefined,
    session: Object.freeze({ binding, connection, id: 'session-weather', timeoutMs: 5_000 }),
    start: async () => undefined,
  };
  const client: McpSessionControllerClient = {
    close: async () => {
      events.push('client.close.start');
      await releaseClient.promise;
      events.push('client.close.reject');
      throw clientCloseFailure;
    },
    connect: async (next) => next.start(),
    request: async (_request, options) => new Promise<unknown>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        events.push('request.abort');
        void releaseRequest.promise.then(() => reject(new DOMException('Aborted', 'AbortError')));
      }, { once: true });
    }),
  };
  const controller = createMcpSessionController({ clientFactory: () => client, routes, transportFactory: () => transport });
  await controller.open(binding);
  const active = controller.invoke({ id: 'active-close', operation: 'listTools', request: {} });
  await eventually(() => controller.model.activeRequests['active-close'] !== undefined);

  const firstClose = controller.close();
  const repeatedClose = controller.close();
  await eventually(() => events.includes('trace.abort') && events.includes('request.abort'));
  expect(events).toEqual(['trace.abort', 'request.abort']);

  releaseRequest.resolve();
  await expect(active).rejects.toMatchObject({ name: 'AbortError' });
  await eventually(() => events.includes('client.close.start') && events.includes('transport.close.start'));
  releaseClient.resolve();
  releaseTransport.resolve();

  const [firstResult, repeatedResult] = await Promise.allSettled([firstClose, repeatedClose]);
  expect(firstResult.status).toBe('rejected');
  expect(repeatedResult.status).toBe('rejected');
  if (firstResult.status !== 'rejected' || repeatedResult.status !== 'rejected') throw new Error('Expected both close calls to reject.');
  expect(repeatedResult.reason).toBe(firstResult.reason);
  expect(firstResult.reason).toMatchObject({
    failures: [
      { reason: clientCloseFailure, resource: 'client' },
      { reason: transportCloseFailure, resource: 'transport' },
    ],
    message: 'MCP session controller close failed for client, transport.',
    name: 'McpSessionControllerCloseError',
  });
  const closeFailure = firstResult.reason as Readonly<{ readonly failures: readonly object[] }>;
  expect(Object.isFrozen(firstResult.reason)).toBe(true);
  expect(Object.isFrozen(closeFailure.failures)).toBe(true);
  expect(closeFailure.failures.every(Object.isFrozen)).toBe(true);
  expect(events).toEqual([
    'trace.abort',
    'request.abort',
    'client.close.start',
    'transport.close.start',
    'client.close.reject',
    'transport.close.reject',
  ]);
  expect(controller.model).toMatchObject({
    diagnostics: [{
      code: 'mcp.close.failed',
      message: 'MCP session controller close failed for client, transport.',
      severity: 'error',
    }],
    phase: 'error',
  });
});
