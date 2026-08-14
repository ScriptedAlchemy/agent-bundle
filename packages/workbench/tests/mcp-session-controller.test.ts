import { expect, it } from '@rstest/core';

import {
  createMcpSessionController,
  type McpSessionControllerClient,
  type McpSessionControllerRoutes,
  type McpSessionControllerTransport,
} from '../src/mcp/mcp-session-controller.ts';

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
  const catalog = deferred<Readonly<Record<string, readonly unknown[]>>>();
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
