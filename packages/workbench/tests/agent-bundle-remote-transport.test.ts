import { expect, it } from '@rstest/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';

import { AgentBundleRemoteTransport } from '../src/mcp/agent-bundle-remote-transport.ts';
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

const routeFetch = (options: {
  readonly operation?: (body: Record<string, unknown>) => unknown;
  readonly streams: readonly Response[];
}): { readonly fetch: typeof fetch; readonly requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  let streamIndex = 0;
  return {
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body?.toString();
      requests.push({ body, headers: new Headers(init?.headers), url });
      if (url === '/api/project/session') return json({ origin: 'http://127.0.0.1:4100', token: 'token-a' });
      if (url === '/api/mcp/sessions') return json({ session: { binding, connection, id: 'session-a' } });
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
      if (url === '/api/project/session') return json({ origin: 'http://127.0.0.1:4100', token: 'token-a' });
      if (url === '/api/mcp/sessions/session-a') return json({ session: { binding, connection, id: 'session-a' } });
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
