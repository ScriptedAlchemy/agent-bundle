import { expect, it } from '@rstest/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';

import { AgentBundleRemoteTransport } from '../src/mcp/agent-bundle-remote-transport.ts';
import { McpRouteClient } from '../src/mcp/mcp-route-client.ts';
import { deferred, eventually } from './support/async.ts';

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

const rawClosedStream = (...chunks: readonly Uint8Array[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
}), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });

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

const binding = Object.freeze({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' });
const connection = Object.freeze({
  capabilities: { tools: {} },
  protocolEra: 'modern',
  protocolVersion: '2025-11-25',
  server: { name: 'weather-fixture', version: '1.0.0' },
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
      if (url === '/api/project/session') return json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a' });
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
      if (url === '/api/project/session') return json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a' });
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

it('rejects noncanonical NDJSON bytes before accepting an MCP trace entry', async () => {
  const encoder = new TextEncoder();
  const streams = [
    rawClosedStream(encoder.encode('{"kind":"frame","sequence":1}')),
    rawClosedStream(Uint8Array.from([0xff, 0x0a])),
    rawClosedStream(encoder.encode('{"kind":"frame","sequence":1,"sequence":2}\n')),
  ];

  for (const stream of streams) {
    const fixture = routeFetch({ streams: [stream] });
    const transport = new AgentBundleRemoteTransport({ binding, routes: new McpRouteClient({ fetch: fixture.fetch }) });
    const errors: string[] = [];
    let closed = false;
    transport.onerror = (error) => errors.push(error.message);
    transport.onclose = () => { closed = true; };

    await transport.start();
    await eventually(() => closed);

    expect(errors).toEqual(['Foreground MCP trace stream contained an invalid entry.']);
    expect(fixture.requests.filter((request) => request.url === '/api/mcp/sessions/session-a')).toHaveLength(1);
  }
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
        if (url === '/api/project/session') return json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a' });
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
          return json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a' });
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
        if (url === '/api/project/session') return json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a' });
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
        if (url === '/api/project/session') return json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a' });
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
        if (url === '/api/project/session') return json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a' });
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
