import { expect, it } from '@rstest/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';

import { AgentBundleRemoteTransport, dispatchAgentBundleMcpRequest } from '../src/mcp/agent-bundle-remote-transport.ts';
import { McpRouteClient } from '../src/mcp/mcp-route-client.ts';

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly url: string;
}

interface HeldStream {
  readonly response: Response;
  close(): void;
  send(value: unknown): void;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const json = (value: unknown, status = 200): Response => Response.json(value, { status });

const heldStream = (): HeldStream => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  return Object.freeze({
    close: () => controller?.close(),
    response,
    send: (value: unknown) => controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`)),
  });
};

const closedStream = (...entries: readonly unknown[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (const entry of entries) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(entry)}\n`));
    controller.close();
  },
}), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const cancellableStream = (): Readonly<{ readonly cancelled: () => boolean; readonly response: Response }> => {
  let wasCancelled = false;
  return Object.freeze({
    cancelled: () => wasCancelled,
    response: new Response(new ReadableStream<Uint8Array>({
      cancel() {
        wasCancelled = true;
      },
    }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }),
  });
};

const eventually = async (predicate: () => boolean, timeout = 300): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms.`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
  }
};

const binding = Object.freeze({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' });
const connection = Object.freeze({
  capabilities: { tools: {} },
  protocolEra: 'modern',
  protocolVersion: '2025-11-25',
  server: { name: 'weather-fixture', version: '1.0.0' },
});
const foregroundBootstrap = Object.freeze({
  cookieName: 'agent-bundle-foreground-session-00000000000000000000000000000000',
  origin: 'http://127.0.0.1:4100',
  token: 'token-a',
});

const routeFetch = (options: {
  readonly operation?: (body: Record<string, unknown>) => unknown;
  readonly streams: readonly Response[];
  readonly timeoutMs?: number;
}): { readonly fetch: typeof fetch; readonly requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  let streamIndex = 0;
  return {
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body?.toString();
      requests.push({ body, headers: new Headers(init?.headers), url });
      if (url === '/api/project/session') return json(foregroundBootstrap);
      if (url === '/api/mcp/sessions') return json({ session: { binding, connection, id: 'session-a', timeoutMs: options.timeoutMs ?? 5_000 } });
      if (url.startsWith('/api/mcp/sessions/session-a/stream?after=')) {
        const response = options.streams[streamIndex];
        streamIndex += 1;
        if (response === undefined) throw new Error('Unexpected extra stream request.');
        return response;
      }
      if (url === '/api/mcp/sessions/session-a/operations') {
        const operation = JSON.parse(body ?? '{}') as Record<string, unknown>;
        return json({ result: options.operation?.(operation) });
      }
      if (url === '/api/mcp/sessions/session-a/cancel') return json({ cancelled: true });
      if (url === '/api/mcp/sessions/session-a' && init?.method === 'DELETE') return json({ closed: true });
      throw new Error(`Unexpected route request ${url}.`);
    },
    requests,
  };
};

it('maps supported SDK requests to authenticated operations and delivers same-id results in send order', async () => {
  const stream = heldStream();
  const fixture = routeFetch({
    operation: (operation) => operation.operation === 'tools/list'
      ? [{ inputSchema: { type: 'object' }, name: 'forecast' }]
      : connection,
    streams: [stream.response],
  });
  const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }) });
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (message) => messages.push(message);

  await transport.start();
  await Promise.all([
    transport.send({ id: 1, jsonrpc: '2.0', method: 'initialize', params: {} }),
    transport.send({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} }),
  ]);
  await eventually(() => messages.length === 2);

  expect(messages).toEqual([
    { id: 1, jsonrpc: '2.0', result: { capabilities: { tools: {} }, protocolVersion: '2025-11-25', serverInfo: { name: 'weather-fixture', version: '1.0.0' } } },
    { id: 2, jsonrpc: '2.0', result: { tools: [{ inputSchema: { type: 'object' }, name: 'forecast' }] } },
  ]);
  expect(fixture.requests.map((request) => request.url)).toEqual([
    '/api/project/session',
    '/api/mcp/sessions',
    '/api/mcp/sessions/session-a/stream?after=0',
    '/api/mcp/sessions/session-a/operations',
    '/api/mcp/sessions/session-a/operations',
  ]);
  expect(fixture.requests[1]?.body).toBe('{"epochId":"epoch-a","serverName":"weather","target":"portable"}');
  for (const request of fixture.requests.slice(1)) {
    expect(request.headers.get('origin')).toBeNull();
    expect(request.headers.get('x-agent-bundle-session')).toBe('token-a');
  }
  expect(fixture.requests[3]?.body).toBe('{"operation":"initialize"}');
  expect(fixture.requests[4]?.body).toBe('{"operation":"tools/list"}');

  await transport.close();
});

it('returns a request-scoped route failure as a same-id JSON-RPC error without reporting a transport fault', async () => {
  const stream = heldStream();
  const transport = new AgentBundleRemoteTransport({
    binding,
    routes: new McpRouteClient({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === '/api/project/session') return json(foregroundBootstrap);
        if (url === '/api/mcp/sessions') return json({ session: { binding, connection, id: 'session-a', timeoutMs: 5_000 } });
        if (url.includes('/stream?')) return stream.response;
        if (url.endsWith('/operations')) return json({ diagnostic: { code: 'AB8024', message: 'Operation cancelled.' } }, 499);
        if (url === '/api/mcp/sessions/session-a' && init?.method === 'DELETE') return json({ closed: true });
        throw new Error(`Unexpected route request ${url}.`);
      },
    }),
  });
  const errors: string[] = [];
  const messages: JSONRPCMessage[] = [];
  transport.onerror = (error) => errors.push(error.message);
  transport.onmessage = (message) => messages.push(message);

  await transport.start();
  await transport.send({ id: 7, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'forecast' } });
  await eventually(() => messages.length === 1);

  expect(messages).toEqual([{ error: { code: -32603, message: 'Operation cancelled.' }, id: 7, jsonrpc: '2.0' }]);
  expect(errors).toEqual([]);
  await transport.close();
});

it('threads one session timeout through the foreground create boundary without widening the binding', async () => {
  const stream = heldStream();
  const fixture = routeFetch({ streams: [stream.response], timeoutMs: 12_345 });
  const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }), timeoutMs: 12_345 });

  await transport.start();

  expect(fixture.requests[1]?.body).toBe('{"epochId":"epoch-a","serverName":"weather","target":"portable","timeoutMs":12345}');
  expect((transport.session as unknown as { readonly timeoutMs?: number }).timeoutMs).toBe(12_345);
  expect(transport.session.binding).toEqual(binding);
  expect('timeoutMs' in transport.session.binding).toBe(false);
  await transport.close();
});

it('resumes an interrupted NDJSON stream after its acknowledged cursor without repeating raw notifications', async () => {
  const live = heldStream();
  const fixture = routeFetch({
    streams: [
      closedStream({
        direction: 'server',
        kind: 'frame',
        message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
        occurredAt: 1,
        sequence: 3,
      }),
      live.response,
    ],
  });
  const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }) });
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (message) => messages.push(message);

  await transport.start();
  await eventually(() => fixture.requests.filter((request) => request.url.includes('/stream?')).length === 2);
  live.send({
    direction: 'server',
    kind: 'frame',
    message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
    occurredAt: 2,
    sequence: 3,
  });
  live.send({
    direction: 'server',
    kind: 'frame',
    message: { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'ready', level: 'info' } },
    occurredAt: 3,
    sequence: 4,
  });
  await eventually(() => messages.length === 2);

  expect(messages).toEqual([
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
    { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'ready', level: 'info' } },
  ]);
  expect(fixture.requests.filter((request) => request.url.includes('/stream?')).map((request) => request.url)).toEqual([
    '/api/mcp/sessions/session-a/stream?after=0',
    '/api/mcp/sessions/session-a/stream?after=3',
  ]);

  await transport.close();
});

it('rejects unsupported SDK requests explicitly and cancels plus closes the bound session exactly once', async () => {
  const stream = heldStream();
  const fixture = routeFetch({ streams: [stream.response] });
  const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }) });
  const messages: JSONRPCMessage[] = [];
  const closed: boolean[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onclose = () => closed.push(true);

  await transport.start();
  await transport.send({ id: 9, jsonrpc: '2.0', method: 'roots/list', params: {} });
  await transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'tool-call-a' } });
  await eventually(() => messages.length === 1);
  await Promise.all([transport.close(), transport.close()]);

  expect(messages).toEqual([{
    error: { code: -32601, message: 'MCP method "roots/list" is not supported by the Agent Bundle remote transport.' },
    id: 9,
    jsonrpc: '2.0',
  }]);
  expect(fixture.requests.filter((request) => request.url.endsWith('/cancel'))).toHaveLength(1);
  expect(fixture.requests.filter((request) => request.url === '/api/mcp/sessions/session-a' && request.headers.get('x-agent-bundle-session') === 'token-a')).toHaveLength(1);
  expect(closed).toEqual([true]);
});

it('uses one foreground bootstrap for the model-facing session, catalog, config, trace, and restart routes', async () => {
  const requests: RecordedRequest[] = [];
  const client = new McpRouteClient({
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
      if (url === '/api/project/session') return json(foregroundBootstrap);
      if (url === '/api/mcp/sessions/session-a') return json({ session: { binding, connection, id: 'session-a', timeoutMs: 5_000 } });
      if (url === '/api/mcp/sessions/session-a/connection') return json({ connection });
      if (url === '/api/mcp/sessions/session-a/catalog') return json({
        prompts: [{ name: 'weather' }],
        resourceTemplates: [{ uriTemplate: 'weather://{city}' }],
        resources: [{ uri: 'weather://today' }],
        tools: [{ name: 'forecast' }],
      });
      if (url === '/api/mcp/sessions/session-a/config') return json({ config: { launch: { command: 'node', kind: 'stdio' } } });
      if (url === '/api/mcp/sessions/session-a/trace?after=4') return json({ trace: { entries: [{ kind: 'stderr', sequence: 5, text: 'ready' }] } });
      if (url === '/api/mcp/sessions/session-a/restart') return json({ connection });
      throw new Error(`Unexpected route request ${url}.`);
    },
  });

  const [session, current, catalog, config, trace, restarted] = await Promise.all([
    client.session('session-a'),
    client.connection('session-a'),
    client.catalog('session-a'),
    client.config('session-a'),
    client.trace('session-a', 4),
    client.restart('session-a'),
  ]);

  expect(session).toMatchObject({ binding, id: 'session-a' });
  expect(current).toEqual(connection);
  expect(catalog).toEqual({
    prompts: [{ name: 'weather' }],
    resourceTemplates: [{ uriTemplate: 'weather://{city}' }],
    resources: [{ uri: 'weather://today' }],
    tools: [{ name: 'forecast' }],
  });
  expect(config).toEqual({ launch: { command: 'node', kind: 'stdio' } });
  expect(trace).toEqual({ entries: [{ kind: 'stderr', sequence: 5, text: 'ready' }] });
  expect(restarted).toEqual(connection);
  expect(requests.filter((request) => request.url === '/api/project/session')).toHaveLength(1);
  expect(requests.filter((request) => request.url !== '/api/project/session').every((request) =>
    request.headers.get('origin') === null && request.headers.get('x-agent-bundle-session') === 'token-a',
  )).toBe(true);
  expect(requests.find((request) => request.url.endsWith('/restart'))?.body).toBe('{}');
});

it('reports malformed trace data and closes its bound session rather than leaving the SDK transport open', async () => {
  const fixture = routeFetch({ streams: [closedStream({ kind: 'frame', sequence: 'not-a-cursor' })] });
  const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }) });
  const errors: string[] = [];
  const closed: boolean[] = [];
  transport.onerror = (error) => errors.push(error.message);
  transport.onclose = () => closed.push(true);

  await transport.start();
  await eventually(() => closed.length === 1);

  expect(errors).toEqual(['Foreground MCP trace stream contained an invalid entry.']);
  expect(fixture.requests.filter((request) => request.url === '/api/mcp/sessions/session-a')).toHaveLength(1);
});

it('forwards only raw server notification frames and never trace responses or server requests with colliding ids', async () => {
  const stream = heldStream();
  const fixture = routeFetch({ streams: [stream.response] });
  const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }) });
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (message) => messages.push(message);

  await transport.start();
  stream.send({ direction: 'server', kind: 'frame', message: { id: 1, jsonrpc: '2.0', result: { tools: [] } }, sequence: 1 });
  stream.send({ direction: 'server', kind: 'frame', message: { id: 2, jsonrpc: '2.0', method: 'sampling/createMessage', params: {} }, sequence: 2 });
  stream.send({ direction: 'server', kind: 'frame', message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, sequence: 3 });
  await eventually(() => messages.length > 0);

  expect(messages).toEqual([{ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }]);
  await transport.close();
});

it('sends MCP cancellation to its typed route while a serialized tool call remains in flight', async () => {
  const operation = deferred<Response>();
  const stream = heldStream();
  const requests: RecordedRequest[] = [];
  let operationStarted = false;
  const transport = new AgentBundleRemoteTransport({
    binding,
    routes: new McpRouteClient({
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
        if (url === '/api/project/session') return json(foregroundBootstrap);
        if (url === '/api/mcp/sessions') return json({ session: { binding, connection, id: 'session-a', timeoutMs: 5_000 } });
        if (url.includes('/stream?')) return stream.response;
        if (url.endsWith('/operations')) {
          operationStarted = true;
          return operation.promise;
        }
        if (url.endsWith('/cancel')) return json({ cancelled: true });
        if (url === '/api/mcp/sessions/session-a' && init?.method === 'DELETE') return json({ closed: true });
        throw new Error(`Unexpected route request ${url}.`);
      },
    }),
  });

  await transport.start();
  const call = transport.send({ id: 7, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'forecast' } });
  await eventually(() => operationStarted);
  const cancelled = transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
  await eventually(() => requests.some((request) => request.url.endsWith('/cancel')));

  operation.resolve(json({ result: { content: [] } }));
  await Promise.all([call, cancelled]);
  expect(requests.find((request) => request.url.endsWith('/cancel'))?.body).toBe('{"requestId":"number:7"}');
  await transport.close();
});

it('closes a session created concurrently without re-bootstrap and notifies only after its DELETE completes', async () => {
  const created = deferred<Response>();
  const lifecycle: string[] = [];
  let bootstraps = 0;
  const transport = new AgentBundleRemoteTransport({
    binding,
    routes: new McpRouteClient({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === '/api/project/session') {
          bootstraps += 1;
          return json(foregroundBootstrap);
        }
        if (url === '/api/mcp/sessions') return created.promise;
        if (url === '/api/mcp/sessions/session-a' && init?.method === 'DELETE') {
          lifecycle.push('delete');
          return json({ closed: true });
        }
        throw new Error(`Unexpected route request ${url}.`);
      },
    }),
  });
  transport.onclose = () => lifecycle.push('close');

  const starting = transport.start();
  await eventually(() => bootstraps === 1);
  const closing = transport.close();
  created.resolve(json({ session: { binding, connection, id: 'session-a', timeoutMs: 5_000 } }));
  await Promise.all([starting, closing]);

  expect(bootstraps).toBe(1);
  expect(lifecycle).toEqual(['delete', 'close']);
});

it('linearizes close by aborting active work, cancelling the reader, waiting cleanup, and suppressing late results', async () => {
  const stream = cancellableStream();
  const requests: RecordedRequest[] = [];
  const messages: JSONRPCMessage[] = [];
  let operationAborted = false;
  let operationStarted = false;
  let resolveOperation: ((response: Response) => void) | undefined;
  const transport = new AgentBundleRemoteTransport({
    binding,
    routes: new McpRouteClient({
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
        if (url === '/api/project/session') return json(foregroundBootstrap);
        if (url === '/api/mcp/sessions') return json({ session: { binding, connection, id: 'session-a', timeoutMs: 5_000 } });
        if (url.includes('/stream?')) return stream.response;
        if (url.endsWith('/operations')) {
          operationStarted = true;
          return new Promise<Response>((resolvePromise) => {
            resolveOperation = resolvePromise;
            init?.signal?.addEventListener('abort', () => {
              operationAborted = true;
              resolvePromise(json({ diagnostic: { code: 'AB8019', message: 'aborted' } }, 499));
            }, { once: true });
          });
        }
        if (url === '/api/mcp/sessions/session-a' && init?.method === 'DELETE') return json({ closed: true });
        throw new Error(`Unexpected route request ${url}.`);
      },
    }),
  });
  transport.onmessage = (message) => messages.push(message);

  await transport.start();
  const pending = transport.send({ id: 13, jsonrpc: '2.0', method: 'tools/list', params: {} });
  await eventually(() => operationStarted);
  const closing = transport.close();
  try {
    await closing;
    expect(operationAborted).toBe(true);
    expect(stream.cancelled()).toBe(true);
    expect(messages).toEqual([]);
    expect(requests.filter((request) => request.url === '/api/mcp/sessions/session-a')).toHaveLength(1);
  } finally {
    resolveOperation?.(json({ result: [{ name: 'late' }] }));
    await pending;
  }
});

it('deletes a mismatched created session using its held foreground token before start rejects', async () => {
  const requests: RecordedRequest[] = [];
  const transport = new AgentBundleRemoteTransport({
    binding,
    routes: new McpRouteClient({
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
        if (url === '/api/project/session') return json(foregroundBootstrap);
        if (url === '/api/mcp/sessions') return json({
          session: { binding: { ...binding, epochId: 'wrong-epoch' }, connection, id: 'session-wrong', timeoutMs: 5_000 },
        });
        if (url === '/api/mcp/sessions/session-wrong' && init?.method === 'DELETE') return json({ closed: true });
        throw new Error(`Unexpected route request ${url}.`);
      },
    }),
  });

  await expect(transport.start()).rejects.toMatchObject({ message: 'Foreground MCP session binding does not match the requested artifact.' });

  expect(requests.map((request) => request.url)).toEqual([
    '/api/project/session',
    '/api/mcp/sessions',
    '/api/mcp/sessions/session-wrong',
  ]);
  expect(requests[2]?.headers.get('x-agent-bundle-session')).toBe('token-a');
});

it('defaults omitted modern tool arguments and gives known invalid parameters a JSON-RPC invalid-params error', async () => {
  const stream = heldStream();
  const fixture = routeFetch({
    operation: () => ({ content: [] }),
    streams: [stream.response],
  });
  const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }) });
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (message) => messages.push(message);

  await transport.start();
  await transport.send({ id: 10, jsonrpc: '2.0', method: 'tools/call', params: { name: 'forecast' } });
  await transport.send({ id: 11, jsonrpc: '2.0', method: 'tools/call', params: { arguments: 'invalid', name: 'forecast' } });
  await transport.send({ id: 12, jsonrpc: '2.0', method: 'unregistered/method', params: {} });
  await eventually(() => messages.length === 3);

  expect(fixture.requests.find((request) => request.url.endsWith('/operations'))?.body).toBe(
    '{"arguments":{},"name":"forecast","operation":"tools/call","requestId":"number:10"}',
  );
  expect(messages).toEqual([
    { id: 10, jsonrpc: '2.0', result: { content: [] } },
    { error: { code: -32602, message: 'MCP method "tools/call" has invalid parameters.' }, id: 11, jsonrpc: '2.0' },
    { error: { code: -32601, message: 'MCP method "unregistered/method" is not supported by the Agent Bundle remote transport.' }, id: 12, jsonrpc: '2.0' },
  ]);
  await transport.close();
});

it('aborts and waits for a bypassed cancellation before releasing its session', async () => {
  const stream = cancellableStream();
  const errors: string[] = [];
  const lifecycle: string[] = [];
  let cancellationAborted = false;
  let cancellationStarted = false;
  let resolveCancellation: ((response: Response) => void) | undefined;
  const transport = new AgentBundleRemoteTransport({
    binding,
    routes: new McpRouteClient({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === '/api/project/session') return json(foregroundBootstrap);
        if (url === '/api/mcp/sessions') return json({ session: { binding, connection, id: 'session-a', timeoutMs: 5_000 } });
        if (url.includes('/stream?')) return stream.response;
        if (url.endsWith('/cancel')) {
          cancellationStarted = true;
          return new Promise<Response>((resolvePromise) => {
            resolveCancellation = resolvePromise;
            init?.signal?.addEventListener('abort', () => {
              cancellationAborted = true;
              lifecycle.push('cancel-abort');
              resolvePromise(json({ diagnostic: { code: 'AB8019', message: 'aborted' } }, 499));
            }, { once: true });
          });
        }
        if (url === '/api/mcp/sessions/session-a' && init?.method === 'DELETE') {
          lifecycle.push('delete');
          return json({ closed: true });
        }
        throw new Error(`Unexpected route request ${url}.`);
      },
    }),
  });
  transport.onerror = (error) => errors.push(error.message);
  transport.onclose = () => lifecycle.push('close');

  await transport.start();
  const cancelling = transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 17 } });
  await eventually(() => cancellationStarted);
  const closing = transport.close();
  try {
    await closing;
    expect(cancellationAborted).toBe(true);
    expect(lifecycle).toEqual(['cancel-abort', 'delete', 'close']);
    expect(errors).toEqual([]);
  } finally {
    resolveCancellation?.(json({ cancelled: true }));
    await cancelling;
  }
});

it('keeps the runtime App dispatcher closed: initialization and ping stay local while only tool and resource methods execute', async () => {
  const executed: unknown[] = [];
  const options = {
    allowedMethods: new Set(['tools/list', 'resources/list', 'tools/call', 'resources/read'] as const),
    connection,
    execute: async (operation: unknown) => {
      executed.push(operation);
      return { value: operation };
    },
  };

  await expect(dispatchAgentBundleMcpRequest({ id: 1, jsonrpc: '2.0', method: 'initialize', params: {} }, options)).resolves.toEqual({
    id: 1,
    jsonrpc: '2.0',
    result: { capabilities: { tools: {} }, protocolVersion: '2025-11-25', serverInfo: { name: 'weather-fixture', version: '1.0.0' } },
  });
  await expect(dispatchAgentBundleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, options)).resolves.toBeUndefined();
  await expect(dispatchAgentBundleMcpRequest({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, options)).rejects.toThrow(
    'MCP remote transport received an invalid notification.',
  );
  await expect(dispatchAgentBundleMcpRequest({ id: 2, jsonrpc: '2.0', method: 'ping' }, options)).resolves.toEqual({
    id: 2,
    jsonrpc: '2.0',
    result: {},
  });
  await expect(dispatchAgentBundleMcpRequest({ id: 3, jsonrpc: '2.0', method: 'tools/call', params: { arguments: { city: 'London' }, name: 'forecast' } }, options)).resolves.toEqual({
    id: 3,
    jsonrpc: '2.0',
    result: { arguments: { city: 'London' }, name: 'forecast', operation: 'tools/call', requestId: 'number:3' },
  });
  await expect(dispatchAgentBundleMcpRequest({ id: 4, jsonrpc: '2.0', method: 'prompts/list' }, options)).resolves.toEqual({
    error: { code: -32601, message: 'MCP method "prompts/list" is not supported by the Agent Bundle remote transport.' },
    id: 4,
    jsonrpc: '2.0',
  });
  await expect(dispatchAgentBundleMcpRequest({ id: 5, jsonrpc: '2.0', method: 'tools/call', params: { arguments: 'invalid', name: 'forecast' } }, options)).resolves.toEqual({
    error: { code: -32602, message: 'MCP method "tools/call" has invalid parameters.' },
    id: 5,
    jsonrpc: '2.0',
  });
  expect(executed).toEqual([{ arguments: { city: 'London' }, name: 'forecast', operation: 'tools/call', requestId: 'number:3' }]);
});

it('uses only exact runtime MCP routes and preserves the operation vector', async () => {
  const requests: RecordedRequest[] = [];
  const runtimeBinding = {
    definitionDigest: 'definition-a',
    registryRevision: 7,
    serverDigest: 'server-a',
    serverName: 'weather',
    sessionId: 'runtime-session-a',
    sessionRevision: 3,
    target: 'portable',
    transportDigest: 'transport-a',
  };
  const restartedSession = {
    binding: {
      definitionDigest: 'definition-b', registryRevision: 8, serverDigest: 'server-b', serverName: 'weather',
      sessionId: 'runtime-session-a', sessionRevision: 4, target: 'portable', transportDigest: 'transport-b',
    },
    connection: {
      capabilities: { resources: { listChanged: true }, tools: { listChanged: true } },
      protocolEra: 'modern', protocolVersion: '2026-02-09', server: { name: 'weather-next', version: '2.0.0' },
    },
    state: 'ready',
  };
  const vector = {
    providerSessionId: 'provider-a', runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateStoreId: 'store-a', stateVersion: 2,
  };
  const client = new McpRouteClient({
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
      if (url === '/api/project/session') return json(foregroundBootstrap);
      if (url === '/api/runtime/mcp/sessions') return json({ session: { binding: runtimeBinding, connection, state: 'ready' } });
      if (url === '/api/runtime/mcp/sessions/runtime-session-a/restart') return json({
        reconcile: {
          action: 'sessions-restarted', invalidatedBindings: [{ sessionId: 'runtime-session-a', sessionRevision: 3 }], registryRevision: 8,
          restartedSessionIds: ['runtime-session-a'], runtimeGenerationId: 'generation-b', sequence: 4,
        },
        session: restartedSession,
      });
      if (url === '/api/runtime/mcp/sessions/runtime-session-a/rpc') return json({ result: {
        operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [{ name: 'forecast' }], vector,
      } });
      if (url === '/api/runtime/mcp/sessions/runtime-session-a' && init?.method === 'DELETE') return json({ closed: true });
      throw new Error(`Unexpected route request ${url}.`);
    },
  });

  const opened = await client.openRuntime({ expectedRegistryRevision: 7, serverName: 'weather', target: 'portable' });
  const restarted = await client.restartRuntime({ expectedSessionRevision: 3, sessionId: 'runtime-session-a' });
  const operation = await client.executeRuntime('runtime-session-a', { expectedSessionRevision: 3, kind: 'list-tools' });
  const called = await client.executeRuntime('runtime-session-a', {
    arguments: { city: 'London' }, expectedSessionRevision: 3, kind: 'call-tool', name: 'forecast', requestId: 'app-request-a',
  });
  await client.closeRuntime({ expectedSessionRevision: 3, sessionId: 'runtime-session-a' });

  expect(opened).toEqual({
    binding: {
      definitionDigest: 'definition-a', registryRevision: 7, serverDigest: 'server-a', serverName: 'weather',
      sessionId: 'runtime-session-a', sessionRevision: 3, target: 'portable', transportDigest: 'transport-a',
    },
    connection,
    state: 'ready',
  });
  expect(Object.hasOwn(opened.binding, 'providerSessionId')).toBe(false);
  expect(Object.hasOwn(opened.binding, 'stateStoreId')).toBe(false);
  expect(restarted).toEqual({
    reconcile: {
      action: 'sessions-restarted', invalidatedBindings: [{ sessionId: 'runtime-session-a', sessionRevision: 3 }], registryRevision: 8,
      restartedSessionIds: ['runtime-session-a'], runtimeGenerationId: 'generation-b', sequence: 4,
    },
    session: restartedSession,
  });
  expect(operation).toMatchObject({ operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [{ name: 'forecast' }], vector });
  expect(called).toMatchObject({ operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [{ name: 'forecast' }], vector });
  expect(requests.map((request) => request.url)).toEqual([
    '/api/project/session',
    '/api/runtime/mcp/sessions',
    '/api/runtime/mcp/sessions/runtime-session-a/restart',
    '/api/runtime/mcp/sessions/runtime-session-a/rpc',
    '/api/runtime/mcp/sessions/runtime-session-a/rpc',
    '/api/runtime/mcp/sessions/runtime-session-a',
  ]);
  expect(requests.slice(1).map((request) => request.body)).toEqual([
    '{"expectedRegistryRevision":7,"serverName":"weather","target":"portable"}',
    '{"expectedSessionRevision":3,"sessionId":"runtime-session-a"}',
    '{"expectedSessionRevision":3,"kind":"list-tools"}',
    '{"arguments":{"city":"London"},"expectedSessionRevision":3,"kind":"call-tool","name":"forecast"}',
    '{"expectedSessionRevision":3,"sessionId":"runtime-session-a"}',
  ]);
});

it('rejects private provider and state-store identifiers in a raw runtime session response', async () => {
  const client = new McpRouteClient({
    fetch: async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return json(foregroundBootstrap);
      if (url === '/api/runtime/mcp/sessions') return json({ session: {
        binding: {
          definitionDigest: 'definition-a', providerSessionId: 'provider-private', registryRevision: 7, serverDigest: 'server-a', serverName: 'weather',
          sessionId: 'runtime-session-a', sessionRevision: 3, stateStoreId: 'state-private', target: 'portable', transportDigest: 'transport-a',
        },
        connection,
        state: 'ready',
      } });
      throw new Error(`Unexpected route request ${url}.`);
    },
  });

  await expect(client.openRuntime({ serverName: 'weather', target: 'portable' })).rejects.toMatchObject({ code: 'AB8019' });
});

it('rejects private and unknown direct connection keys in raw runtime open snapshots', async () => {
  const invalidFields = [
    ['providerSessionId', 'provider-private'],
    ['stateStoreId', 'state-private'],
    ['unexpected', 'unexpected-value'],
  ] as const;

  for (const [field, value] of invalidFields) {
    const client = new McpRouteClient({
      fetch: async (input) => {
        const url = String(input);
        if (url === '/api/project/session') return json(foregroundBootstrap);
        if (url === '/api/runtime/mcp/sessions') return json({ session: {
          binding: {
            definitionDigest: 'definition-a', registryRevision: 7, serverDigest: 'server-a', serverName: 'weather',
            sessionId: 'runtime-session-a', sessionRevision: 3, target: 'portable', transportDigest: 'transport-a',
          },
          connection: { ...connection, [field]: value },
          state: 'ready',
        } });
        throw new Error(`Unexpected route request ${url}.`);
      },
    });

    await expect(client.openRuntime({ serverName: 'weather', target: 'portable' })).rejects.toMatchObject({ code: 'AB8019' });
  }
});

it('preserves opaque nested capability keys in a raw runtime connection snapshot', async () => {
  const client = new McpRouteClient({
    fetch: async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return json(foregroundBootstrap);
      if (url === '/api/runtime/mcp/sessions') return json({ session: {
        binding: {
          definitionDigest: 'definition-a', registryRevision: 7, serverDigest: 'server-a', serverName: 'weather',
          sessionId: 'runtime-session-a', sessionRevision: 3, target: 'portable', transportDigest: 'transport-a',
        },
        connection: { ...connection, capabilities: { arbitrary: { nested: ['value'] } } },
        state: 'ready',
      } });
      throw new Error(`Unexpected route request ${url}.`);
    },
  });

  await expect(client.openRuntime({ serverName: 'weather', target: 'portable' })).resolves.toMatchObject({
    connection: { capabilities: { arbitrary: { nested: ['value'] } } },
  });
});

it('rejects malformed direct server keys in raw runtime open and restart snapshots', async () => {
  const invalidFields = [
    ['providerSessionId', 'provider-private'],
    ['stateStoreId', 'state-private'],
    ['unexpected', 'unexpected-value'],
  ] as const;
  const operations = ['open', 'restart'] as const;

  for (const operation of operations) {
    for (const [field, value] of invalidFields) {
      const client = new McpRouteClient({
        fetch: async (input) => {
          const url = String(input);
          if (url === '/api/project/session') return json(foregroundBootstrap);
          const runtimeSession = {
            binding: {
              definitionDigest: 'definition-b', registryRevision: 8, serverDigest: 'server-b', serverName: 'weather',
              sessionId: 'runtime-session-a', sessionRevision: operation === 'open' ? 3 : 4, target: 'portable', transportDigest: 'transport-b',
            },
            connection: { ...connection, server: { name: 'weather-fixture', version: '1.0.0', [field]: value } },
            state: 'ready',
          };
          if (operation === 'open' && url === '/api/runtime/mcp/sessions') return json({ session: runtimeSession });
          if (operation === 'restart' && url === '/api/runtime/mcp/sessions/runtime-session-a/restart') return json({
            reconcile: {
              action: 'sessions-restarted', invalidatedBindings: [{ sessionId: 'runtime-session-a', sessionRevision: 3 }], registryRevision: 8,
              restartedSessionIds: ['runtime-session-a'], runtimeGenerationId: 'generation-b', sequence: 4,
            },
            session: runtimeSession,
          });
          throw new Error(`Unexpected route request ${url}.`);
        },
      });

      const request = operation === 'open'
        ? client.openRuntime({ serverName: 'weather', target: 'portable' })
        : client.restartRuntime({ expectedSessionRevision: 3, sessionId: 'runtime-session-a' });
      await expect(request).rejects.toMatchObject({ code: 'AB8019' });
    }
  }
});

it('rejects private and unknown direct keys in raw runtime restart success DTOs', async () => {
  const invalidFields = [
    ['providerSessionId', 'provider-private'],
    ['stateStoreId', 'state-private'],
    ['unexpected', 'unexpected-value'],
  ] as const;
  const levels = ['connection', 'reconcile', 'invalidatedBinding'] as const;

  for (const level of levels) {
    for (const [field, value] of invalidFields) {
      const client = new McpRouteClient({
        fetch: async (input) => {
          const url = String(input);
          if (url === '/api/project/session') return json(foregroundBootstrap);
          if (url === '/api/runtime/mcp/sessions/runtime-session-a/restart') return json({
            reconcile: {
              action: 'sessions-restarted',
              invalidatedBindings: [{
                sessionId: 'runtime-session-a',
                sessionRevision: 3,
                ...(level === 'invalidatedBinding' ? { [field]: value } : {}),
              }],
              registryRevision: 8,
              restartedSessionIds: ['runtime-session-a'],
              runtimeGenerationId: 'generation-b',
              sequence: 4,
              ...(level === 'reconcile' ? { [field]: value } : {}),
            },
            session: {
              binding: {
                definitionDigest: 'definition-b', registryRevision: 8, serverDigest: 'server-b', serverName: 'weather',
                sessionId: 'runtime-session-a', sessionRevision: 4, target: 'portable', transportDigest: 'transport-b',
              },
              connection: { ...connection, ...(level === 'connection' ? { [field]: value } : {}) },
              state: 'ready',
            },
          });
          throw new Error(`Unexpected route request ${url}.`);
        },
      });

      await expect(client.restartRuntime({ expectedSessionRevision: 3, sessionId: 'runtime-session-a' })).rejects.toMatchObject({ code: 'AB8019' });
    }
  }
});

it('rejects a runtime restart snapshot that disagrees with the reconciliation evidence', async () => {
  const client = new McpRouteClient({
    fetch: async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return json(foregroundBootstrap);
      if (url === '/api/runtime/mcp/sessions/runtime-session-a/restart') return json({
        reconcile: {
          action: 'sessions-restarted', invalidatedBindings: [{ sessionId: 'runtime-session-a', sessionRevision: 3 }], registryRevision: 8,
          restartedSessionIds: ['runtime-session-a'], runtimeGenerationId: 'generation-b', sequence: 4,
        },
        session: {
          binding: {
            definitionDigest: 'definition-b', registryRevision: 7, serverDigest: 'server-b', serverName: 'weather',
            sessionId: 'runtime-session-a', sessionRevision: 4, target: 'portable', transportDigest: 'transport-b',
          },
          connection,
          state: 'ready',
        },
      });
      throw new Error(`Unexpected route request ${url}.`);
    },
  });

  await expect(client.restartRuntime({ expectedSessionRevision: 3, sessionId: 'runtime-session-a' })).rejects.toMatchObject({ code: 'AB8019' });
});
