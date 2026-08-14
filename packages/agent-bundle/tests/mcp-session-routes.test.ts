import { createServer, get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  McpSessionRoutes,
  type McpSessionRouteService,
  type McpSessionRouteSession,
} from '../src/dev/mcp-session-routes.ts';
import type {
  McpSessionConnectionState,
  McpSessionInspectorConfig,
  McpSessionReplayOverflow,
  McpSessionTraceListener,
  McpSessionTraceMessage,
  McpSessionTraceReplay,
} from '../src/dev/mcp-session-service.ts';

interface StartedRoutes {
  readonly close: () => Promise<void>;
  readonly routes: McpSessionRoutes;
  readonly url: string;
}

const routeError = (code: string, message: string, status: number): Error & {
  readonly code: string;
  readonly message: string;
  readonly status: number;
} => Object.assign(new Error(message), { code, message, status });

const authorize = (request: IncomingMessage): void => {
  if (request.headers.origin !== 'http://127.0.0.1:4567') {
    throw routeError('AB8003', 'Request origin is not this foreground server.', 403);
  }
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

const startRoutes = async (service: McpSessionRouteService): Promise<StartedRoutes> => {
  const routes = new McpSessionRoutes({ authorize, service });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const diagnostic = error as Partial<{ code: string; message: string; status: number }>;
      response.writeHead(diagnostic.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ diagnostic: {
        code: diagnostic.code ?? 'AB8007',
        message: diagnostic.message ?? 'Request could not be completed.',
      } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => {
      routes.close();
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
    },
    routes,
    url: `http://127.0.0.1:${address.port}`,
  });
};

class RecordingSession implements McpSessionRouteSession {
  readonly binding = Object.freeze({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' });
  readonly connection = Object.freeze({ capabilities: { tools: {} }, protocolEra: 'modern' as const, protocolVersion: '2025-11-25', server: { name: 'fixture', version: '1.0.0' } });
  readonly id = 'session-a';
  readonly calls: unknown[] = [];
  readonly #listeners = new Set<McpSessionTraceListener>();
  readonly #replay: McpSessionTraceMessage[] = [];
  #traceOverflow: McpSessionReplayOverflow | undefined;
  #sequence = 0;

  callTool(options: { readonly arguments: Record<string, unknown>; readonly name: string; readonly requestId?: string }): Promise<unknown> {
    this.calls.push({ kind: 'callTool', options });
    return Promise.resolve({ content: [{ text: 'forecast', type: 'text' }], structuredContent: { temperature: 20 } });
  }

  cancel(requestId: string): boolean {
    this.calls.push({ kind: 'cancel', requestId });
    return requestId === 'request-a';
  }

  getPrompt(options: { readonly arguments?: Record<string, string>; readonly name: string }): Promise<unknown> {
    this.calls.push({ kind: 'getPrompt', options });
    return Promise.resolve({ messages: [] });
  }

  inspectorConfig(): McpSessionInspectorConfig {
    return { launch: { args: ['server.mjs'], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' };
  }

  listPrompts(): Promise<readonly unknown[]> {
    return Promise.resolve([{ name: 'weather' }]);
  }

  listResources(): Promise<readonly unknown[]> {
    return Promise.resolve([{ uri: 'weather://today' }]);
  }

  listResourceTemplates(): Promise<readonly unknown[]> {
    return Promise.resolve([{ uriTemplate: 'weather://{city}' }]);
  }

  listTools(): Promise<readonly unknown[]> {
    return Promise.resolve([{ inputSchema: { type: 'object' }, name: 'forecast' }]);
  }

  readResource(options: { readonly uri: string }): Promise<unknown> {
    this.calls.push({ kind: 'readResource', options });
    return Promise.resolve({ contents: [{ text: 'sunny', uri: options.uri }] });
  }

  restart(): Promise<McpSessionConnectionState> {
    this.calls.push({ kind: 'restart' });
    return Promise.resolve(this.connection);
  }

  trace(afterSequence = 0): McpSessionTraceReplay {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('MCP session trace cursor must be a nonnegative safe integer.');
    }
    if (afterSequence > this.#sequence) {
      throw new RangeError('MCP session trace cursor cannot be ahead of the current trace.');
    }
    return { entries: [], ...(this.#traceOverflow === undefined ? {} : { overflow: this.#traceOverflow }) };
  }

  subscribeTrace(
    options: { readonly afterSequence?: number },
    listener: McpSessionTraceListener,
  ): { readonly unsubscribe: () => void } {
    this.trace(options.afterSequence);
    for (const entry of this.#replay) listener(entry);
    this.#listeners.add(listener);
    return Object.freeze({ unsubscribe: () => this.#listeners.delete(listener) });
  }

  publish(entry: McpSessionTraceMessage): void {
    this.#sequence += 1;
    for (const listener of this.#listeners) listener(entry);
  }

  queueReplay(entry: McpSessionTraceMessage): void {
    this.#sequence += 1;
    this.#replay.push(entry);
  }

  setTraceOverflow(overflow: McpSessionReplayOverflow): void {
    this.#traceOverflow = overflow;
  }

  get subscriptionCount(): number {
    return this.#listeners.size;
  }
}

class RecordingService implements McpSessionRouteService {
  readonly session = new RecordingSession();
  readonly opens: unknown[] = [];
  closeCalls = 0;
  closeError: Error | undefined;

  async closeSession(id: string): Promise<boolean> {
    this.closeCalls += 1;
    if (this.closeError !== undefined) throw this.closeError;
    return id === this.session.id;
  }

  get(id: string): McpSessionRouteSession | undefined {
    return id === this.session.id ? this.session : undefined;
  }

  async open(options: { readonly epochId: string; readonly serverName: string; readonly target: string }): Promise<McpSessionRouteSession> {
    this.opens.push(options);
    return this.session;
  }
}

const headers = (): Readonly<Record<string, string>> => ({
  origin: 'http://127.0.0.1:4567',
  'x-agent-bundle-session': 'test-session-token',
});

const readLines = async (response: Response, count: number): Promise<readonly unknown[]> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Expected route stream body.');
  const decoder = new TextDecoder();
  let buffered = '';
  const lines: unknown[] = [];
  while (lines.length < count) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    const split = buffered.split('\n');
    buffered = split.pop() ?? '';
    for (const line of split) if (line.length > 0) lines.push(JSON.parse(line));
  }
  await reader.cancel();
  return lines;
};

const eventually = async (predicate: () => boolean, milliseconds: number): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${milliseconds}ms.`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
};

const within = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => Promise.race([
  promise,
  new Promise<T>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

const readToEnd = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const next = await reader.read();
    if (next.done) return output;
    output += decoder.decode(next.value, { stream: true });
  }
};

const readAbortedStream = async (url: string): Promise<string> => new Promise((resolvePromise) => {
  let output = '';
  const request = httpGet(url, { headers: headers() }, (response) => {
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      output += chunk;
    });
    response.once('close', () => resolvePromise(output));
    response.once('error', () => resolvePromise(output));
  });
  request.once('error', () => resolvePromise(output));
});

it('accepts only an epoch target and server name when creating a session', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const rejected = await fetch(`${started.url}/api/mcp/sessions`, {
      body: JSON.stringify({ command: '/tmp/untrusted', epochId: 'epoch-a', serverName: 'weather', target: 'portable' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      diagnostic: { code: 'AB8016', message: 'MCP session request has an invalid shape.' },
    });
    expect(service.opens).toEqual([]);

    const created = await fetch(`${started.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({
      session: {
        binding: { epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
        connection: service.session.connection,
        id: 'session-a',
      },
    });
    expect(service.opens).toEqual([{ epochId: 'epoch-a', serverName: 'weather', target: 'portable' }]);
  } finally {
    await started.close();
  }
});

it('requires the foreground origin and token before every MCP session operation', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const response = await fetch(`${started.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' }),
      headers: { 'content-type': 'application/json', origin: 'http://invalid.example' },
      method: 'POST',
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' },
    });
    expect(service.opens).toEqual([]);
  } finally {
    await started.close();
  }
});

it('exposes the frozen operation and catalog surface without a generic launch or JSON-RPC escape hatch', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const [catalog, config, operation] = await Promise.all([
      fetch(`${started.url}/api/mcp/sessions/session-a/catalog`, { headers: headers() }),
      fetch(`${started.url}/api/mcp/sessions/session-a/config`, { headers: headers() }),
      fetch(`${started.url}/api/mcp/sessions/session-a/operations`, {
        body: JSON.stringify({ arguments: { city: 'Paris' }, name: 'forecast', operation: 'tools/call', requestId: 'request-a' }),
        headers: { ...headers(), 'content-type': 'application/json' },
        method: 'POST',
      }),
    ]);

    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toEqual({
      prompts: [{ name: 'weather' }],
      resourceTemplates: [{ uriTemplate: 'weather://{city}' }],
      resources: [{ uri: 'weather://today' }],
      tools: [{ inputSchema: { type: 'object' }, name: 'forecast' }],
    });
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toEqual({ config: service.session.inspectorConfig() });
    expect(operation.status).toBe(200);
    await expect(operation.json()).resolves.toEqual({
      result: { content: [{ text: 'forecast', type: 'text' }], structuredContent: { temperature: 20 } },
    });
    expect(service.session.calls).toContainEqual({
      kind: 'callTool',
      options: { arguments: { city: 'Paris' }, name: 'forecast', requestId: 'request-a' },
    });

    const rejected = await fetch(`${started.url}/api/mcp/sessions/session-a/operations`, {
      body: JSON.stringify({ command: '/tmp/untrusted', operation: 'initialize' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      diagnostic: { code: 'AB8016', message: 'MCP session request has an invalid shape.' },
    });
  } finally {
    await started.close();
  }
});

it('streams an atomic trace through authenticated fetch and releases its subscription on route shutdown', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const stream = await fetch(`${started.url}/api/mcp/sessions/session-a/stream?after=0`, { headers: headers() });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(service.session.subscriptionCount).toBe(1);

    service.session.publish({ kind: 'operation', occurredAt: 1, operation: 'listTools', phase: 'succeeded', sequence: 1 });
    await expect(readLines(stream, 1)).resolves.toEqual([
      { kind: 'operation', occurredAt: 1, operation: 'listTools', phase: 'succeeded', sequence: 1 },
    ]);

    started.routes.close();
    expect(service.session.subscriptionCount).toBe(0);
  } finally {
    await started.close();
  }
});

it('ends an authenticated trace reader exactly once after DELETE closes its session', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const stream = await fetch(`${started.url}/api/mcp/sessions/session-a/stream?after=0`, { headers: headers() });
    reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected route stream body.');
    expect(service.session.subscriptionCount).toBe(1);

    const deleted = await fetch(`${started.url}/api/mcp/sessions/session-a`, { headers: headers(), method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ closed: true });
    await expect(within(readToEnd(reader), 250)).resolves.toBe('');
    expect(service.session.subscriptionCount).toBe(0);
    expect(service.closeCalls).toBe(1);
  } finally {
    await reader?.cancel();
    await started.close();
  }
});

it('releases an authenticated trace reader when DELETE session cleanup rejects after removal', async () => {
  const service = new RecordingService();
  service.closeError = new Error('session cleanup rejected after removal');
  const started = await startRoutes(service);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const stream = await fetch(`${started.url}/api/mcp/sessions/session-a/stream?after=0`, { headers: headers() });
    reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected route stream body.');
    expect(service.session.subscriptionCount).toBe(1);

    const deleted = await fetch(`${started.url}/api/mcp/sessions/session-a`, { headers: headers(), method: 'DELETE' });
    expect(deleted.status).toBe(502);
    await expect(deleted.json()).resolves.toEqual({
      diagnostic: { code: 'AB8019', message: 'MCP session operation could not be completed.' },
    });
    await expect(within(readToEnd(reader), 250)).resolves.toBe('');
    expect(service.session.subscriptionCount).toBe(0);
    expect(service.closeCalls).toBe(1);
  } finally {
    await reader?.cancel();
    await started.close();
  }
});

it('keeps an authenticated trace reader open while cancel and restart preserve the session', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const stream = await fetch(`${started.url}/api/mcp/sessions/session-a/stream?after=0`, { headers: headers() });
    reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected route stream body.');
    const [cancel, restart] = await Promise.all([
      fetch(`${started.url}/api/mcp/sessions/session-a/cancel`, {
        body: JSON.stringify({ requestId: 'request-a' }),
        headers: { ...headers(), 'content-type': 'application/json' },
        method: 'POST',
      }),
      fetch(`${started.url}/api/mcp/sessions/session-a/restart`, {
        body: '{}',
        headers: { ...headers(), 'content-type': 'application/json' },
        method: 'POST',
      }),
    ]);
    await expect(cancel.json()).resolves.toEqual({ cancelled: true });
    await expect(restart.json()).resolves.toEqual({ connection: service.session.connection });
    expect(service.session.subscriptionCount).toBe(1);
    expect(service.session.calls).toContainEqual({ kind: 'cancel', requestId: 'request-a' });
    expect(service.session.calls).toContainEqual({ kind: 'restart' });
  } finally {
    await reader?.cancel();
    await started.close();
  }
});

it('unsubscribes a synchronous replay stream when bounded backpressure closes it before subscription assignment', async () => {
  const service = new RecordingService();
  const oversized = 'x'.repeat(512 * 1024);
  service.session.queueReplay({ kind: 'logging', occurredAt: 1, payload: oversized, sequence: 1 });
  service.session.queueReplay({ kind: 'logging', occurredAt: 2, payload: oversized, sequence: 2 });
  const started = await startRoutes(service);

  try {
    await new Promise<void>((resolvePromise) => {
      const request = httpGet(`${started.url}/api/mcp/sessions/session-a/stream?after=0`, { headers: headers() }, (response) => {
        response.resume();
        resolvePromise();
      });
      request.once('error', () => resolvePromise());
    });
    await eventually(() => service.session.subscriptionCount === 0, 250);
  } finally {
    await started.close();
  }
});

it('closes an oversized first replay frame before any NDJSON bytes reach the reader', async () => {
  const service = new RecordingService();
  service.session.queueReplay({ kind: 'logging', occurredAt: 1, payload: 'x'.repeat(512 * 1024), sequence: 1 });
  const started = await startRoutes(service);

  try {
    await expect(within(readAbortedStream(`${started.url}/api/mcp/sessions/session-a/stream?after=0`), 250)).resolves.toBe('');
    expect(service.session.subscriptionCount).toBe(0);
  } finally {
    await started.close();
  }
});

it('reports malformed, gap, and ahead trace cursors plus an unknown session with stable diagnostics', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    service.session.setTraceOverflow({ afterSequence: 0, droppedThroughSequence: 7 });
    const [malformed, gap, ahead, missing] = await Promise.all([
      fetch(`${started.url}/api/mcp/sessions/session-a/trace?after=bad`, { headers: headers() }),
      fetch(`${started.url}/api/mcp/sessions/session-a/trace?after=0`, { headers: headers() }),
      fetch(`${started.url}/api/mcp/sessions/session-a/trace?after=1`, { headers: headers() }),
      fetch(`${started.url}/api/mcp/sessions/missing`, { headers: headers() }),
    ]);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8017', message: 'MCP session trace cursor is not valid.' },
    });
    expect(gap.status).toBe(200);
    await expect(gap.json()).resolves.toEqual({
      trace: { entries: [], overflow: { afterSequence: 0, droppedThroughSequence: 7 } },
    });
    expect(ahead.status).toBe(409);
    await expect(ahead.json()).resolves.toEqual({
      diagnostic: { code: 'AB8017', message: 'MCP session trace cursor is ahead of the current trace.' },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      diagnostic: { code: 'AB8015', message: 'MCP session is not available.' },
    });
  } finally {
    await started.close();
  }
});

it('enforces the shared JSON media and body-size limits on MCP session creation', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const plain = await fetch(`${started.url}/api/mcp/sessions`, {
      body: '{}',
      headers: { ...headers(), 'content-type': 'text/plain' },
      method: 'POST',
    });
    expect(plain.status).toBe(415);
    await expect(plain.json()).resolves.toEqual({
      diagnostic: { code: 'AB8009', message: 'Request body must use application/json.' },
    });

    const oversized = await fetch(`${started.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: 'epoch-a', serverName: 'x'.repeat(64 * 1024), target: 'portable' }),
      headers: { ...headers(), 'content-type': 'application/json; charset=utf-8' },
      method: 'POST',
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      diagnostic: { code: 'AB8010', message: 'Request body exceeds 64 KiB.' },
    });
    expect(service.opens).toEqual([]);
  } finally {
    await started.close();
  }
});
