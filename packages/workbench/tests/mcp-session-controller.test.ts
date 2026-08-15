import { expect, it } from '@rstest/core';

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
    session: Object.freeze({ binding, connection, id: 'session-weather' }),
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

  await expect(controller.open({ ...binding, command: 'sh', env: { TOKEN: 'leak' }, path: '/tmp/other' } as typeof binding)).rejects.toThrow(
    'MCP session binding must contain only epochId, target, and serverName.',
  );
  expect(controller.model).toMatchObject({ phase: 'idle' });
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
    session: Object.freeze({ binding, connection, id: 'session-weather' }),
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
        session: Object.freeze({ binding, connection, id: 'session-weather' }),
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
    session: Object.freeze({ binding, connection, id: 'session-weather' }),
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
    session: Object.freeze({ binding, connection, id: 'session-weather' }),
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
