import { expect, it } from '@rstest/core';
import { specTypeSchemas, type Client, type Transport } from '@modelcontextprotocol/client';
import { mcpCorrelationMetaKey } from '../../agent-bundle/src/contracts/mcp-session.ts';
import type { McpAppBoundOperationResult } from '../../agent-bundle/src/dev/mcp-app-runtime-binding-service.ts';
import type { McpAppBindingOperation } from '../../agent-bundle/src/dev/mcp-app-runtime-preview-service.ts';

import {
  createMcpSessionController,
  type McpSessionControllerClient,
  type McpSessionControllerRoutes,
  type McpSessionControllerTransport,
} from '../src/mcp/mcp-session-controller.ts';
import { McpRouteClientError, type McpRouteCatalog } from '../src/mcp/mcp-route-client.ts';

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
const runtimeAppVector = Object.freeze({ runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 2 });
const runtimeAppResult = (
  operation: McpAppBindingOperation,
  sequence = 1,
): McpAppBoundOperationResult => Object.freeze({
  operationId: `runtime-app-operation-${sequence}`,
  sessionId: 'runtime-session-a',
  sessionRevision: 3,
  value: operation.kind === 'tools/list'
    ? Object.freeze([{ name: 'forecast' }])
    : operation.kind === 'resources/list'
      ? Object.freeze([{ uri: 'weather://today' }])
      : operation.kind === 'resources/read'
        ? Object.freeze({ contents: Object.freeze([{ text: 'sunny', uri: operation.uri }]) })
        : Object.freeze({ content: Object.freeze([{ text: `forecast:${operation.name}`, type: 'text' }]) }),
  vector: runtimeAppVector,
});
const runtimeAppAttachment = (
  execute: (operation: McpAppBindingOperation, signal?: AbortSignal) => Promise<McpAppBoundOperationResult>,
  onResult?: (operation: McpAppBindingOperation, result: McpAppBoundOperationResult) => void,
) => Object.freeze({
  bindingId: 'runtime-app-binding-a',
  execute,
  ...(onResult === undefined ? {} : { onResult }),
});
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
const implementationUpdatedRuntimeSession = Object.freeze({
  binding: Object.freeze({
    ...runtimeSession.binding,
    serverDigest: 'server-implementation-b',
  }),
  connection: Object.freeze({
    ...runtimeSession.connection,
    server: Object.freeze({ name: 'weather-runtime-implementation', version: '4.2.1' }),
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
    close: () => {
      try { controller?.close(); } catch (error) {
        if (!(error instanceof TypeError && error.message === 'Invalid state: Controller is already closed')) throw error;
      }
    },
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

it('attaches one non-owning runtime App client through one exact App authority and preserves ordered public App request history', async () => {
  const calls: string[] = [];
  const appOperations: McpAppBindingOperation[] = [];
  const appTraces: Array<Readonly<{ readonly kind: string; readonly operationId: string; readonly vector: object }>> = [];
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
      executeRuntime: async () => { throw new Error('Runtime App attachment must not use the legacy runtime MCP route executor.'); },
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
  const attachment = runtimeAppAttachment(
    async (operation) => {
      appOperations.push(operation);
      return runtimeAppResult(operation, appOperations.length);
    },
    (operation, result) => appTraces.push(Object.freeze({ kind: operation.kind, operationId: result.operationId, vector: result.vector })),
  );
  const attach = (authority: typeof attachment): Promise<Awaited<ReturnType<typeof controller.attachApp>>> =>
    (controller.attachApp as unknown as (this: typeof controller, input: typeof attachment) => Promise<Awaited<ReturnType<typeof controller.attachApp>>>).call(controller, authority);
  const app = await attach(attachment);
  const messages: unknown[] = [];
  if (attachedTransport === undefined) throw new Error('Expected controller-owned attached transport.');
  attachedTransport.onmessage = (message) => messages.push(message);
  await attachedTransport.send({ id: 0, jsonrpc: '2.0', method: 'initialize' });
  await attachedTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  await attachedTransport.send({ id: 2, jsonrpc: '2.0', method: 'resources/list' });
  await attachedTransport.send({ id: 3, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'weather://today' } });
  await attachedTransport.send({
    id: 4,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { _meta: { [mcpCorrelationMetaKey]: 'corr-runtime-app' }, arguments: { city: 'Paris' }, name: 'forecast' },
  });
  await attachedTransport.send({ id: 5, jsonrpc: '2.0', method: 'prompts/list' });
  await expect(attachedTransport.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })).rejects.toThrow(
    'MCP remote transport received an invalid notification.',
  );

  expect(app).toMatchObject({ sessionId: 'runtime-session-a', sessionRevision: 3 });
  expect(messages).toEqual([
    { id: 0, jsonrpc: '2.0', result: { capabilities: { resources: { listChanged: true }, tools: { listChanged: true } }, protocolVersion: '2026-07-28', serverInfo: { name: 'weather-runtime', version: '4.2.0' } } },
    { id: 1, jsonrpc: '2.0', result: { tools: [{ name: 'forecast' }] } },
    { id: 2, jsonrpc: '2.0', result: { resources: [{ uri: 'weather://today' }] } },
    { id: 3, jsonrpc: '2.0', result: { contents: [{ text: 'sunny', uri: 'weather://today' }] } },
    { id: 4, jsonrpc: '2.0', result: { content: [{ text: 'forecast:forecast', type: 'text' }] } },
    { error: { code: -32601, message: 'MCP method "prompts/list" is not supported by the Agent Bundle remote transport.' }, id: 5, jsonrpc: '2.0' },
  ]);
  expect(appOperations).toEqual([
    { kind: 'tools/list' },
    { kind: 'resources/list' },
    { kind: 'resources/read', uri: 'weather://today' },
    { arguments: { city: 'Paris' }, correlationId: 'corr-runtime-app', kind: 'tools/call', name: 'forecast' },
  ]);
  expect(calls).toEqual([]);
  expect(controller.history).toEqual([
    expect.objectContaining({ operation: 'listTools', result: [{ name: 'forecast' }] }),
    expect.objectContaining({ operation: 'listResources', result: [{ uri: 'weather://today' }] }),
    expect.objectContaining({ operation: 'readResource', result: { contents: [{ text: 'sunny', uri: 'weather://today' }] } }),
    expect.objectContaining({ operation: 'callTool', result: { content: [{ text: 'forecast:forecast', type: 'text' }] } }),
  ]);
  expect(controller.history.every((entry) => !Object.hasOwn(entry, 'vector'))).toBe(true);
  expect(appTraces).toEqual([
    { kind: 'tools/list', operationId: 'runtime-app-operation-1', vector: runtimeAppVector },
    { kind: 'resources/list', operationId: 'runtime-app-operation-2', vector: runtimeAppVector },
    { kind: 'resources/read', operationId: 'runtime-app-operation-3', vector: runtimeAppVector },
    { kind: 'tools/call', operationId: 'runtime-app-operation-4', vector: runtimeAppVector },
  ]);

  await controller.restart();
  expect(controller.model).toMatchObject({
    binding: { kind: 'runtime', binding: restartedRuntimeSession.binding },
    connection: { protocolVersion: '2026-02-09', serverCapabilities: { resources: { listChanged: true }, tools: { listChanged: true } }, serverInfo: { name: 'weather-runtime-next', version: '5.0.0' } },
  });
  expect(calls).toEqual(['app-client.close', 'runtime.restart:3']);

  const replacement = await attach(attachment);
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
  expect(calls).toEqual(['app-client.close', 'runtime.restart:3']);
  await controller.close();
  expect(calls).toEqual(['app-client.close', 'runtime.restart:3', 'app-client.close', 'runtime.close:4']);
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
  const first = deferred<McpAppBoundOperationResult>();
  const calls: string[] = [];
  let attachedTransport: Transport | undefined;
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
      executeRuntime: async () => { throw new Error('Unexpected legacy runtime route operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  const attachment = runtimeAppAttachment(async (operation) => {
    calls.push(operation.kind);
    return calls.length === 1 ? first.promise : runtimeAppResult(operation, calls.length);
  });
  await controller.attachApp(attachment);
  if (attachedTransport === undefined) throw new Error('Expected controller-owned attached transport.');
  const tools = attachedTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  await eventually(() => calls.length === 1);
  const resources = attachedTransport.send({ id: 2, jsonrpc: '2.0', method: 'resources/list' });
  await Promise.resolve();
  expect(calls).toEqual(['tools/list']);

  first.resolve(runtimeAppResult({ kind: 'tools/list' }));
  await Promise.all([tools, resources]);
  expect(calls).toEqual(['tools/list', 'resources/list']);
  await controller.close();
});

it('rejects injected App results from a foreign session or stale revision before SDK delivery or public tracing', async () => {
  let attachedTransport: Transport | undefined;
  const traces: Array<Readonly<{ readonly kind: string; readonly sessionRevision: number }>> = [];
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
      executeRuntime: async () => { throw new Error('Unexpected legacy runtime route operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  const staleResults = [
    Object.freeze({ ...runtimeAppResult({ kind: 'tools/list' }), sessionId: 'runtime-session-b' }),
    Object.freeze({ ...runtimeAppResult({ kind: 'tools/list' }), sessionRevision: 4 }),
  ];
  await controller.attachApp(Object.freeze({
    bindingId: 'runtime-app-binding-a',
    execute: async () => staleResults.shift() ?? runtimeAppResult({ kind: 'tools/list' }),
    onResult: (operation: McpAppBindingOperation, result: McpAppBoundOperationResult) => {
      traces.push(Object.freeze({ kind: operation.kind, sessionRevision: result.sessionRevision }));
    },
  }));
  if (attachedTransport === undefined) throw new Error('Expected controller-owned attached transport.');
  const messages: unknown[] = [];
  attachedTransport.onmessage = (message) => messages.push(message);

  await attachedTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  await attachedTransport.send({ id: 2, jsonrpc: '2.0', method: 'tools/list' });

  expect(messages).toEqual([
    {
      error: { code: -32603, message: 'Runtime MCP App operation response belongs to a stale session revision.' },
      id: 1,
      jsonrpc: '2.0',
    },
    {
      error: { code: -32603, message: 'Runtime MCP App operation response belongs to a stale session revision.' },
      id: 2,
      jsonrpc: '2.0',
    },
  ]);
  expect(traces).toEqual([]);
  expect(controller.history).toEqual([
    expect.objectContaining({ error: { message: 'Runtime MCP App operation response belongs to a stale session revision.', name: 'McpSessionControllerError' }, operation: 'listTools' }),
    expect.objectContaining({ error: { message: 'Runtime MCP App operation response belongs to a stale session revision.', name: 'McpSessionControllerError' }, operation: 'listTools' }),
  ]);
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
  const attachment = runtimeAppAttachment(async (operation) => runtimeAppResult(operation));
  const first = controller.attachApp(attachment);
  const second = controller.attachApp(attachment);
  await expect(controller.attachApp(Object.freeze({ bindingId: 'runtime-app-binding-b', execute: attachment.execute }))).rejects.toThrow(
    'different runtime App binding authority',
  );
  await eventually(() => connects === 1);
  connected.resolve();
  const [left, right] = await Promise.all([first, second]);

  expect(clients).toHaveLength(1);
  expect(left.client).toBe(right.client);
  await expect(controller.attachApp(Object.freeze({
    bindingId: 'runtime-app-binding-b',
    execute: attachment.execute,
  }))).rejects.toThrow('different runtime App binding authority');
  await left.close();
  const fresh = await controller.attachApp(attachment);
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
  const attachment = runtimeAppAttachment(async (operation) => runtimeAppResult(operation));
  const attached = await controller.attachApp(attachment);
  await expect(attached.close()).rejects.toBe(firstFailure);
  const retained = await controller.attachApp(attachment);
  expect(retained.client).toBe(attached.client);
  expect(appClients).toBe(1);

  await expect(controller.close()).rejects.toMatchObject({
    failures: [{ reason: retryFailure, resource: 'app-client' }],
  });
  expect(closeAttempts).toBe(2);
  expect(appClients).toBe(1);
});

it('drains an old runtime attachment across restart without publishing its stale result', async () => {
  const first = deferred<McpAppBoundOperationResult>();
  const transports: Transport[] = [];
  const closedClients: number[] = [];
  const requests: string[] = [];
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
      executeRuntime: async () => { throw new Error('Unexpected legacy runtime route operation.'); },
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
  const attachment = runtimeAppAttachment(async (operation) => {
    requests.push(operation.kind);
    return requests.length === 1 ? first.promise : Object.freeze({
      operationId: 'operation-2', sessionId: 'runtime-session-a', sessionRevision: 4, value: Object.freeze([{ name: 'fresh' }]),
      vector: Object.freeze({ runtimeGenerationId: 'generation-b', sourceRevision: 'source-b', stateVersion: 3 }),
    });
  });
  const old = await controller.attachApp(attachment);
  const oldTransport = transports[0];
  if (oldTransport === undefined) throw new Error('Expected first runtime attachment.');
  const oldMessages: unknown[] = [];
  oldTransport.onmessage = (message) => oldMessages.push(message);
  const oldOperation = oldTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
  await eventually(() => requests.length === 1);
  const restarting = controller.restart();
  first.resolve(Object.freeze({
    operationId: 'operation-1', sessionId: 'runtime-session-a', sessionRevision: 3, value: Object.freeze([{ name: 'stale' }]),
    vector: runtimeAppVector,
  }));
  await Promise.all([oldOperation, restarting]);

  expect(oldMessages).toEqual([]);
  expect(closedClients).toEqual([1]);
  expect(controller.history).toEqual([]);
  const fresh = await controller.attachApp(attachment);
  const freshTransport = transports[1];
  if (freshTransport === undefined) throw new Error('Expected replacement runtime attachment.');
  await freshTransport.send({ id: 2, jsonrpc: '2.0', method: 'tools/list' });
  expect(fresh.sessionRevision).toBe(4);
  expect(requests).toEqual(['tools/list', 'tools/list']);
  await controller.close();
  await old.close();
});

it('aborts an in-flight runtime route operation before the coalesced controller close publishes a stale result', async () => {
  const completed = deferred<Awaited<ReturnType<NonNullable<McpSessionControllerRoutes['executeRuntime']>>>>();
  const started = deferred<void>();
  const closeCalls: string[] = [];
  let routeSignal: AbortSignal | undefined;
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => { closeCalls.push('runtime.close'); },
      config: async () => ({}),
      executeRuntime: (async (_sessionId: string, _request: unknown, signal?: AbortSignal) => {
        routeSignal = signal;
        started.resolve();
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          void completed.promise.then(resolve, reject);
        });
      }) as McpSessionControllerRoutes['executeRuntime'],
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });
  const cancellation = new AbortController();
  let invoking: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;

  try {
    await controller.open(runtimeBinding);
    invoking = controller.invoke({ id: 'runtime-route-cancel', operation: 'listTools', request: {}, signal: cancellation.signal });
    await started.promise;

    cancellation.abort(new DOMException('Runtime route invocation cancelled.', 'AbortError'));
    expect(routeSignal).toBeInstanceOf(AbortSignal);
    expect(routeSignal).not.toBe(cancellation.signal);
    expect(routeSignal?.aborted).toBe(true);
    closing = controller.close();
    expect(controller.close()).toBe(closing);

    await expect(invoking).rejects.toBe(cancellation.signal.reason);
    await expect(closing).resolves.toBeUndefined();
    expect(closeCalls).toEqual(['runtime.close']);
    expect(controller.history.some((entry) => entry.id === 'runtime-route-cancel')).toBe(false);
  } finally {
    completed.resolve(Object.freeze({
      operationId: 'runtime-route-operation-a',
      sessionId: 'runtime-session-a',
      sessionRevision: 3,
      value: Object.freeze([{ name: 'forecast' }]),
      vector: Object.freeze({
        providerSessionId: 'provider-a', runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateStoreId: 'store-a', stateVersion: 2,
      }),
    }));
    await invoking?.catch(() => undefined);
    await closing?.catch(() => undefined);
    await controller.close().catch(() => undefined);
  }
});

it('aborts an attached runtime App operation during a coalesced controller close without publishing a stale result', async () => {
  const completed = deferred<McpAppBoundOperationResult>();
  const started = deferred<void>();
  const closeCalls: string[] = [];
  let appSignal: AbortSignal | undefined;
  let attachedTransport: Transport | undefined;
  const controller = createMcpSessionController({
    appClientFactory: () => ({
      close: async () => undefined,
      connect: async (transport: Transport) => { attachedTransport = transport; await transport.start(); },
      request: async () => undefined,
    }) as unknown as Client,
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => { closeCalls.push('runtime.close'); },
      config: async () => ({}),
      executeRuntime: async () => { throw new Error('Attached App must not use the legacy runtime route executor.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => unusedRuntimeRestart,
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });
  let sending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  try {
    await controller.open(runtimeBinding);
    await controller.attachApp(runtimeAppAttachment(async (operation, signal?: AbortSignal) => {
      appSignal = signal;
      started.resolve();
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        void completed.promise.then(resolve, reject);
      });
    }));
    if (attachedTransport === undefined) throw new Error('Expected controller-owned attached transport.');
    sending = attachedTransport.send({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
    await started.promise;

    closing = controller.close();
    expect(controller.cancel('app:1')).toBe(true);
    expect(controller.close()).toBe(closing);
    expect(appSignal).toBeInstanceOf(AbortSignal);
    expect(appSignal?.aborted).toBe(true);

    await expect(sending).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(closeCalls).toEqual(['runtime.close']);
    expect(controller.history.some((entry) => entry.id === 'app:1')).toBe(false);
  } finally {
    completed.resolve(runtimeAppResult({ kind: 'tools/list' }));
    await sending?.catch(() => undefined);
    await closing?.catch(() => undefined);
    await controller.close().catch(() => undefined);
  }
});

it('adopts an authoritative higher runtime session revision without reopening the stable session', async () => {
  let runtimeRouteCalls = 0;
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => { runtimeRouteCalls += 1; },
      config: async () => ({}),
      executeRuntime: async () => { runtimeRouteCalls += 1; throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { runtimeRouteCalls += 1; throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => { runtimeRouteCalls += 1; throw new Error('Unexpected runtime session restart.'); },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  await controller.adoptRuntimeSession(restartedRuntimeSession);

  expect(controller.model).toMatchObject({
    binding: { binding: restartedRuntimeSession.binding, kind: 'runtime' },
    connection: {
      protocolVersion: restartedRuntimeSession.connection.protocolVersion,
      serverInfo: restartedRuntimeSession.connection.server,
    },
    phase: 'ready',
  });
  expect(runtimeRouteCalls).toBe(0);
  await controller.close();
});

it('adopts a same-revision implementation update without reopening the stable runtime session', async () => {
  let runtimeRouteCalls = 0;
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => { runtimeRouteCalls += 1; },
      config: async () => ({}),
      executeRuntime: async () => { runtimeRouteCalls += 1; throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { runtimeRouteCalls += 1; throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => { runtimeRouteCalls += 1; throw new Error('Unexpected runtime session restart.'); },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  await controller.adoptRuntimeSession(implementationUpdatedRuntimeSession);

  expect(controller.model).toMatchObject({
    binding: { binding: implementationUpdatedRuntimeSession.binding, kind: 'runtime' },
    connection: {
      protocolVersion: implementationUpdatedRuntimeSession.connection.protocolVersion,
      serverInfo: implementationUpdatedRuntimeSession.connection.server,
    },
    phase: 'ready',
  });
  expect(runtimeRouteCalls).toBe(0);
  await controller.close();
});

it('coalesces an exact authoritative adoption while its old App attachment drains', async () => {
  const appClose = deferred<void>();
  let appCloses = 0;
  const controller = createMcpSessionController({
    appClientFactory: () => ({
      close: async () => { appCloses += 1; await appClose.promise; },
      connect: async (transport: Transport) => transport.start(),
      request: async () => undefined,
    }) as unknown as Client,
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async () => { throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => { throw new Error('Unexpected runtime session restart.'); },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  await controller.attachApp(runtimeAppAttachment(async (operation) => runtimeAppResult(operation)));
  const first = controller.adoptRuntimeSession(restartedRuntimeSession);
  const second = controller.adoptRuntimeSession(restartedRuntimeSession);
  expect(second).toBe(first);
  await eventually(() => appCloses === 1);
  expect(controller.model.phase).toBe('restarting');

  appClose.resolve();
  await first;
  expect(controller.model.binding).toEqual({ binding: restartedRuntimeSession.binding, kind: 'runtime' });
  await controller.close();
});

it('drains the attached App before one implementation-only adoption and fences a conflicting authority', async () => {
  const appClose = deferred<void>();
  let appCloses = 0;
  const controller = createMcpSessionController({
    appClientFactory: () => ({
      close: async () => { appCloses += 1; await appClose.promise; },
      connect: async (transport: Transport) => transport.start(),
      request: async () => undefined,
    }) as unknown as Client,
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async () => { throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => { throw new Error('Unexpected runtime session restart.'); },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  await controller.attachApp(runtimeAppAttachment(async (operation) => runtimeAppResult(operation)));
  const first = controller.adoptRuntimeSession(implementationUpdatedRuntimeSession);
  const second = controller.adoptRuntimeSession(implementationUpdatedRuntimeSession);
  expect(second).toBe(first);
  await expect(controller.adoptRuntimeSession(restartedRuntimeSession)).rejects.toThrow('already running for a different session authority');
  await eventually(() => appCloses === 1);
  expect(controller.model).toMatchObject({ binding: { binding: runtimeSession.binding, kind: 'runtime' }, phase: 'restarting' });

  appClose.resolve();
  await first;
  expect(controller.model).toMatchObject({ binding: { binding: implementationUpdatedRuntimeSession.binding, kind: 'runtime' }, phase: 'ready' });
  await controller.close();
});

it('retains the old ready runtime authority when attached cleanup rejects, then permits an exact retry', async () => {
  const cleanupFailure = new Error('attached App cleanup failed');
  let closeAttempts = 0;
  const controller = createMcpSessionController({
    appClientFactory: () => ({
      close: async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw cleanupFailure;
      },
      connect: async (transport: Transport) => transport.start(),
      request: async () => undefined,
    }) as unknown as Client,
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async () => { throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => { throw new Error('Unexpected runtime session restart.'); },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  await controller.attachApp(runtimeAppAttachment(async (operation) => runtimeAppResult(operation)));
  await expect(controller.adoptRuntimeSession(restartedRuntimeSession)).rejects.toMatchObject({
    failures: [{ reason: cleanupFailure, resource: 'app-client' }],
  });
  expect(controller.model).toMatchObject({ binding: { binding: runtimeSession.binding, kind: 'runtime' }, phase: 'ready' });

  await controller.adoptRuntimeSession(restartedRuntimeSession);
  expect(closeAttempts).toBe(2);
  expect(controller.model).toMatchObject({ binding: { binding: restartedRuntimeSession.binding, kind: 'runtime' }, phase: 'ready' });
  await controller.close();
});

it('rejects non-authoritative runtime adoption lanes without disturbing the ready authority', async () => {
  const foreign = Object.freeze({
    ...restartedRuntimeSession,
    binding: Object.freeze({ ...restartedRuntimeSession.binding, sessionId: 'runtime-session-foreign' }),
  });
  const wrongServer = Object.freeze({
    ...restartedRuntimeSession,
    binding: Object.freeze({ ...restartedRuntimeSession.binding, serverName: 'foreign-runtime' }),
  });
  const wrongTarget = Object.freeze({
    ...restartedRuntimeSession,
    binding: Object.freeze({ ...restartedRuntimeSession.binding, target: 'codex' as const }),
  });
  const registryOnly = Object.freeze({
    ...implementationUpdatedRuntimeSession,
    binding: Object.freeze({ ...implementationUpdatedRuntimeSession.binding, registryRevision: 8 }),
  });
  const sessionOnly = Object.freeze({
    ...implementationUpdatedRuntimeSession,
    binding: Object.freeze({ ...implementationUpdatedRuntimeSession.binding, sessionRevision: 4 }),
  });
  const mixedRevision = Object.freeze({
    ...restartedRuntimeSession,
    binding: Object.freeze({ ...restartedRuntimeSession.binding, registryRevision: 6 }),
  });
  const downgraded = Object.freeze({
    ...implementationUpdatedRuntimeSession,
    binding: Object.freeze({ ...implementationUpdatedRuntimeSession.binding, registryRevision: 6, sessionRevision: 2 }),
  });
  const sameRevisionDefinition = Object.freeze({
    ...implementationUpdatedRuntimeSession,
    binding: Object.freeze({ ...implementationUpdatedRuntimeSession.binding, definitionDigest: 'definition-b' }),
  });
  const sameRevisionTransport = Object.freeze({
    ...implementationUpdatedRuntimeSession,
    binding: Object.freeze({ ...implementationUpdatedRuntimeSession.binding, transportDigest: 'transport-b' }),
  });
  const nonReady = Object.freeze({ ...implementationUpdatedRuntimeSession, state: 'restarting' as const });
  const malformed = Object.freeze({
    ...implementationUpdatedRuntimeSession,
    binding: Object.freeze({ ...implementationUpdatedRuntimeSession.binding, serverDigest: '' }),
  });
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async () => undefined,
      config: async () => ({}),
      executeRuntime: async () => { throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => { throw new Error('Unexpected runtime session restart.'); },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  for (const invalid of [
    foreign,
    wrongServer,
    wrongTarget,
    runtimeSession,
    registryOnly,
    sessionOnly,
    mixedRevision,
    downgraded,
    sameRevisionDefinition,
    sameRevisionTransport,
  ]) {
    await expect(controller.adoptRuntimeSession(invalid)).rejects.toThrow('does not advance the current stable session authority');
    expect(controller.model).toMatchObject({ binding: { binding: runtimeSession.binding, kind: 'runtime' }, phase: 'ready' });
  }
  for (const invalid of [nonReady, malformed]) {
    await expect(controller.adoptRuntimeSession(invalid)).rejects.toThrow('requires a current ready runtime session snapshot');
    expect(controller.model).toMatchObject({ binding: { binding: runtimeSession.binding, kind: 'runtime' }, phase: 'ready' });
  }
  await controller.close();
});

it('fences an in-flight runtime adoption when the controller closes', async () => {
  const appClose = deferred<void>();
  const closeCalls: Array<Readonly<{ readonly expectedSessionRevision: number; readonly sessionId: string }>> = [];
  const controller = createMcpSessionController({
    appClientFactory: () => ({
      close: async () => appClose.promise,
      connect: async (transport: Transport) => transport.start(),
      request: async () => undefined,
    }) as unknown as Client,
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      closeRuntime: async (request) => { closeCalls.push(request); },
      config: async () => ({}),
      executeRuntime: async () => { throw new Error('Unexpected runtime operation.'); },
      openRuntime: async () => { throw new Error('Unexpected runtime session open.'); },
      restart: async () => connection,
      restartRuntime: async () => { throw new Error('Unexpected runtime session restart.'); },
      stream: async () => new Response(null),
      trace: async () => ({ entries: [] }),
    },
    transportFactory: fakeTransport,
  });

  await controller.open(runtimeBinding);
  await controller.attachApp(runtimeAppAttachment(async (operation) => runtimeAppResult(operation)));
  const adoption = controller.adoptRuntimeSession(restartedRuntimeSession);
  const closing = controller.close();
  appClose.resolve();
  await Promise.all([adoption, closing]);

  expect(controller.model.phase).toBe('closed');
  expect(controller.model.binding).not.toEqual({ binding: restartedRuntimeSession.binding, kind: 'runtime' });
  expect(closeCalls).toEqual([{ expectedSessionRevision: 3, sessionId: 'runtime-session-a' }]);
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

it('accepts the largest representable replay gap and rejects an overflow before deriving its earliest cursor', async () => {
  const acceptedStream = traceStream();
  const accepted = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => acceptedStream.response,
      trace: async () => ({ entries: [], overflow: { afterSequence: 0, droppedThroughSequence: Number.MAX_SAFE_INTEGER - 1 } }),
    },
    transportFactory: fakeTransport,
  });
  await accepted.open(binding);
  expect(accepted.model.timeline.entries).toContainEqual({
    earliestAvailableSequence: Number.MAX_SAFE_INTEGER,
    latestDroppedSequence: Number.MAX_SAFE_INTEGER - 1,
    requestedAfterSequence: 0,
    type: 'replay.gap',
  });
  acceptedStream.close();
  await accepted.close();

  const rejectedStream = traceStream();
  const rejected = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => rejectedStream.response,
      trace: async () => ({ entries: [], overflow: { afterSequence: 0, droppedThroughSequence: Number.MAX_SAFE_INTEGER } }),
    },
    transportFactory: fakeTransport,
  });
  await expect(rejected.open(binding)).rejects.toThrow('Foreground MCP trace stream contained an invalid entry.');
  expect(rejected.model.timeline.entries).toEqual([]);
  rejectedStream.close();
  await expect(rejected.close()).rejects.toThrow('Foreground MCP trace stream contained an invalid entry.');
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

it('maps the task operations (#369) onto the 2025-11-25 wire with the SDK schema each result is validated against', async () => {
  const stream = traceStream();
  const routes: McpSessionControllerRoutes = {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => connection,
    stream: async () => stream.response,
    trace: async () => ({ entries: [] }),
  };
  const requests: { readonly request: unknown; readonly schema: unknown }[] = [];
  const task = { createdAt: '2026-09-04T00:00:00.000Z', lastUpdatedAt: '2026-09-04T00:00:00.000Z', pollInterval: 250, status: 'working', taskId: 'task-1', ttl: 600_000 };
  const client: McpSessionControllerClient = {
    close: async () => undefined,
    connect: async (transport) => transport.start(),
    request: async (request, _options, resultSchema) => {
      requests.push({ request, schema: resultSchema });
      if (request.method === 'tools/call') return { task };
      if (request.method === 'tasks/list') return { tasks: [task] };
      if (request.method === 'tasks/result') return { content: [{ text: 'done', type: 'text' }] };
      return { ...task, ...(request.method === 'tasks/cancel' ? { status: 'cancelled' } : {}) };
    },
  };
  const controller = createMcpSessionController({ clientFactory: () => client, routes, transportFactory: () => fakeTransport() });
  await controller.open(binding);

  await expect(controller.invoke({ id: 'task-create', operation: 'callToolTask', request: { arguments: { holdMs: 400 }, name: 'wait', task: { ttl: 600_000 } } }))
    .resolves.toEqual({ task });
  await expect(controller.invoke({ id: 'task-create-default', operation: 'callToolTask', request: { arguments: {}, name: 'wait' } })).resolves.toEqual({ task });
  await expect(controller.invoke({ id: 'task-get', operation: 'getTask', request: { taskId: 'task-1' } })).resolves.toEqual(task);
  await expect(controller.invoke({ id: 'task-result', operation: 'getTaskResult', request: { taskId: 'task-1' } })).resolves.toEqual({ content: [{ text: 'done', type: 'text' }] });
  await expect(controller.invoke({ id: 'task-list', operation: 'listTasks', request: {} })).resolves.toEqual({ tasks: [task] });
  await expect(controller.invoke({ id: 'task-cancel', operation: 'cancelTask', request: { taskId: 'task-1' } })).resolves.toMatchObject({ status: 'cancelled' });

  expect(requests.map((entry) => entry.request)).toEqual([
    { method: 'tools/call', params: { arguments: { holdMs: 400 }, name: 'wait', task: { ttl: 600_000 } } },
    // A task call always carries a `task` object: that is what makes it task-augmented.
    { method: 'tools/call', params: { arguments: {}, name: 'wait', task: {} } },
    { method: 'tasks/get', params: { taskId: 'task-1' } },
    { method: 'tasks/result', params: { taskId: 'task-1' } },
    { method: 'tasks/list', params: {} },
    { method: 'tasks/cancel', params: { taskId: 'task-1' } },
  ]);
  // Task methods are outside the SDK's typed surface, so each names its SDK result schema; an ordinary call passes none.
  expect(requests.map((entry) => entry.schema)).toEqual([
    specTypeSchemas.CreateTaskResult,
    specTypeSchemas.CreateTaskResult,
    specTypeSchemas.GetTaskResult,
    specTypeSchemas.CallToolResult,
    specTypeSchemas.ListTasksResult,
    specTypeSchemas.CancelTaskResult,
  ]);
  await controller.invoke({ id: 'plain', operation: 'callTool', request: { arguments: {}, name: 'echo' } });
  expect(requests.at(-1)).toEqual({ request: { method: 'tools/call', params: { arguments: {}, name: 'echo' } }, schema: undefined });
  expect(controller.history.map((entry) => entry.operation)).toEqual([
    'callToolTask', 'callToolTask', 'getTask', 'getTaskResult', 'listTasks', 'cancelTask', 'callTool',
  ]);

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

it('keeps the session ready when a cancelled request later reports its operation route failure', async () => {
  const stream = traceStream();
  let requests = 0;
  const transport = fakeTransport();
  const client: McpSessionControllerClient = {
    close: async () => undefined,
    connect: async (next) => next.start(),
    request: async (_request, options) => {
      requests += 1;
      if (requests > 1) return { content: [] };
      return new Promise<unknown>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    },
  };
  const controller = createMcpSessionController({
    clientFactory: () => client,
    routes: {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => stream.response,
      trace: async () => ({ entries: [] }),
    },
    transportFactory: () => transport,
  });
  await controller.open(binding);
  const pending = controller.invoke({ id: 'cancelled-1', operation: 'callTool', request: { name: 'wait' } });
  await eventually(() => controller.model.activeRequests['cancelled-1'] !== undefined);

  expect(controller.cancel('cancelled-1')).toBe(true);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  transport.onerror?.(new McpRouteClientError('AB8019', 'MCP session operation could not be completed.'));

  expect(controller.model.phase).toBe('ready');
  await expect(controller.invoke({ id: 'after-cancel', operation: 'listTools', request: {} })).resolves.toEqual({ content: [] });
  stream.close();
  await controller.close();
});

it('keeps generic and non-operation route transport failures terminal', async () => {
  const failures = [
    new Error('connection lost'),
    new McpRouteClientError('AB8018', 'MCP session is not available.'),
    new McpRouteClientError('AB8019', 'Foreground MCP request failed with HTTP 502.'),
  ];
  for (const failure of failures) {
    const stream = traceStream();
    const transport = fakeTransport();
    const controller = createMcpSessionController({
      clientFactory: fakeClient,
      routes: {
        ...emptyRoutes,
        stream: async () => stream.response,
      },
      transportFactory: () => transport,
    });
    await controller.open(binding);

    transport.onerror?.(failure);
    stream.close();
    await eventually(() => controller.model.phase === 'error');

    expect(controller.model.diagnostics).toContainEqual(expect.objectContaining({ code: 'mcp.transport.error' }));
    await expect(controller.close()).rejects.toMatchObject({ primary: failure });
  }
});

it('snapshots terminal transport classification before notifying a mutating observer', async () => {
  const stream = traceStream();
  const transport = fakeTransport();
  const failure = new McpRouteClientError('AB8018', 'MCP session is not available.');
  transport.onerror = (reason) => {
    Object.defineProperties(reason, {
      code: { configurable: true, value: 'AB8019' },
      message: { configurable: true, value: 'MCP session operation could not be completed.' },
    });
  };
  const controller = createMcpSessionController({
    clientFactory: fakeClient,
    routes: {
      ...emptyRoutes,
      stream: async () => stream.response,
    },
    transportFactory: () => transport,
  });
  await controller.open(binding);

  transport.onerror(failure);
  const invocation = controller.invoke({ id: 'after-terminal-error', operation: 'listTools', request: {} });
  stream.close();

  await expect(invocation).rejects.toThrow('MCP session controller cannot invoke while failed.');
  await eventually(() => controller.model.phase === 'error');
  expect(controller.model.diagnostics).toContainEqual(expect.objectContaining({ code: 'mcp.transport.error' }));
  await expect(controller.close()).rejects.toMatchObject({ primary: failure });
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

it('keeps a built MCP App resource frame in the live trace', async () => {
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

  const text = 'x'.repeat(2 * 1024 * 1024);
  stream.send({ direction: 'server', kind: 'frame', message: { result: { contents: [{ text }] } }, occurredAt: 1, sequence: 1 });
  await eventually(() => controller.model.timeline.entries.length === 1);

  expect(controller.model.phase).toBe('ready');
  expect(controller.model.timeline.entries).toEqual([
    { direction: 'server', kind: 'frame', message: { result: { contents: [{ text }] } }, occurredAt: 1, sequence: 1 },
  ]);
  stream.close();
  await controller.close();
});

it('carries the lifted frame id, method, and _meta correlation keys onto the browser frame', async () => {
  const stream = traceStream();
  const routes: McpSessionControllerRoutes = { ...emptyRoutes, stream: async () => stream.response };
  const controller = createMcpSessionController({ clientFactory: fakeClient, routes, transportFactory: fakeTransport });
  await controller.open(binding);

  const message = { id: 7, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'forecast' } };
  stream.send({ direction: 'client', id: '7', kind: 'frame', message, meta: { correlationId: 'corr-1', requestId: 'req-1' }, method: 'tools/call', occurredAt: 1, sequence: 1 });
  stream.send({ direction: 'server', kind: 'frame', message: { jsonrpc: '2.0', method: 'notifications/progress' }, method: 'notifications/progress', occurredAt: 2, sequence: 2 });
  await eventually(() => controller.model.timeline.entries.length === 2);

  expect(controller.model.timeline.entries).toEqual([
    { direction: 'client', id: '7', kind: 'frame', message, meta: { correlationId: 'corr-1', requestId: 'req-1' }, method: 'tools/call', occurredAt: 1, sequence: 1 },
    { direction: 'server', kind: 'frame', message: { jsonrpc: '2.0', method: 'notifications/progress' }, method: 'notifications/progress', occurredAt: 2, sequence: 2 },
  ]);
  stream.close();
  await controller.close();
});

it('fails the trace stream on a frame whose lifted keys are unbounded or carry an unknown meta key', async () => {
  const frame = { direction: 'client', kind: 'frame', message: {}, occurredAt: 1, sequence: 1 };
  for (const corrupt of [
    { ...frame, id: 'x'.repeat(257) },
    { ...frame, method: '' },
    { ...frame, meta: { correlationId: 7 } },
    { ...frame, meta: { toolUseId: 'toolu_01' } },
    { ...frame, meta: 'corr-1' },
  ]) {
    const stream = traceStream();
    const controller = createMcpSessionController({
      clientFactory: fakeClient,
      routes: { ...emptyRoutes, stream: async () => stream.response },
      transportFactory: fakeTransport,
    });
    await controller.open(binding);
    stream.send(corrupt);
    await eventually(() => controller.model.phase === 'error');
    expect(controller.model.diagnostics).toContainEqual(expect.objectContaining({ code: 'mcp.trace.stream.error' }));
    expect(controller.model.timeline.entries).toEqual([]);
    stream.close();
    await controller.close();
  }
});

it('stamps an invoke correlationId into the SDK request _meta under the route\'s key', async () => {
  const sent: unknown[] = [];
  const client: McpSessionControllerClient = {
    ...fakeClient(),
    request: async (request) => { sent.push(request); return { content: [] }; },
  };
  const controller = createMcpSessionController({ clientFactory: () => client, routes: emptyRoutes, transportFactory: fakeTransport });
  await controller.open(binding);

  await controller.invoke({ correlationId: 'corr-app', id: 'call-1', operation: 'callTool', request: { arguments: { city: 'London' }, name: 'forecast' } });
  await controller.invoke({ id: 'call-2', operation: 'callTool', request: { arguments: {}, name: 'forecast' } });
  await controller.invoke({ correlationId: 'corr-task', id: 'call-3', operation: 'callToolTask', request: { arguments: {}, name: 'forecast', task: { ttl: 1_000 } } });

  expect(sent).toEqual([
    { method: 'tools/call', params: { _meta: { [mcpCorrelationMetaKey]: 'corr-app' }, arguments: { city: 'London' }, name: 'forecast' } },
    { method: 'tools/call', params: { arguments: {}, name: 'forecast' } },
    { method: 'tools/call', params: { _meta: { [mcpCorrelationMetaKey]: 'corr-task' }, arguments: {}, name: 'forecast', task: { ttl: 1_000 } } },
  ]);
  await controller.close();
});

const invalidTraceBodies = (): readonly (readonly [string, BodyInit])[] => {
  const entry = { direction: 'server', kind: 'logging', occurredAt: 1, payload: { message: 'partial' }, sequence: 1 };
  const serialized = JSON.stringify(entry);
  const prefix = new TextEncoder().encode(serialized.slice(0, serialized.indexOf('partial')));
  const suffix = new TextEncoder().encode(`${serialized.slice(serialized.indexOf('partial') + 'partial'.length)}\n`);
  const malformed = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
  malformed.set(prefix);
  malformed[prefix.byteLength] = 0xff;
  malformed.set(suffix, prefix.byteLength + 1);
  return [
    ['a duplicate-key frame', `${serialized.replace('"message":"partial"', '"message":"first","message":"partial"')}\n`],
    ['an unterminated frame', serialized],
    ['invalid UTF-8', malformed],
  ];
};

for (const [name, body] of invalidTraceBodies()) {
  it(`rejects ${name} from the MCP trace instead of publishing partial telemetry`, async () => {
    const routes: McpSessionControllerRoutes = {
      catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
      config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
      restart: async () => connection,
      stream: async () => new Response(body, {
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

    expect(controller.model.logs).toEqual([]);
    expect(controller.model.diagnostics).toContainEqual(expect.objectContaining({ code: 'mcp.trace.stream.error' }));
    await controller.close();
  });
}

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
