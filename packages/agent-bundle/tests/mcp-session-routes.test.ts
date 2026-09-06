
import { expect, it } from '@rstest/core';
import { readToEnd, within } from './support/eventually.ts';

import {
  McpSessionRoutes,
  type McpSessionRouteService,
  type McpSessionRouteSession,
} from '../src/dev/mcp-session/mcp-session-routes.ts';
import { McpSessionStaleEpochError } from '../src/dev/mcp-session/mcp-session-service.ts';
import type {
  McpSessionConnectionState,
  McpSessionInspectorConfig,
  McpSessionReplayOverflow,
  McpSessionTraceListener,
  McpSessionTraceMessage,
  McpSessionTraceReplay,
  McpSessionTraceSubscription,
} from '../src/dev/mcp-session/mcp-session-service.ts';
import {
  authorize,
  originHeaders as headers,
  startRoutes as startRouteServer,
  type StartedRoutes,
} from './support/route-harness.ts';

const startRoutes = async (service: McpSessionRouteService): Promise<StartedRoutes<McpSessionRoutes>> =>
  startRouteServer(new McpSessionRoutes({ authorize, service }));

class RecordingSession implements McpSessionRouteSession {
  readonly binding = Object.freeze({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' });
  readonly connection = Object.freeze({ capabilities: { tools: {} }, protocolEra: 'modern' as const, protocolVersion: '2025-11-25', server: { name: 'fixture', version: '1.0.0' } });
  readonly id = 'session-a';
  readonly timeoutMs = 5_000;
  readonly calls: unknown[] = [];
  readonly #listeners = new Set<McpSessionTraceListener>();
  readonly #replay: McpSessionTraceMessage[] = [];
  #traceOverflow: McpSessionReplayOverflow | undefined;
  #sequence = 0;

  callToolError: Error | undefined;

  callTool(options: { readonly arguments: Record<string, unknown>; readonly name: string; readonly requestId?: string }): Promise<unknown> {
    this.calls.push({ kind: 'callTool', options });
    if (this.callToolError !== undefined) return Promise.reject(this.callToolError);
    return Promise.resolve({ content: [{ text: 'forecast', type: 'text' }], structuredContent: { temperature: 20 } });
  }

  callToolTask(options: { readonly arguments: Record<string, unknown>; readonly name: string; readonly requestId?: string; readonly task: Readonly<Record<string, unknown>> }): Promise<unknown> {
    this.calls.push({ kind: 'callToolTask', options });
    return Promise.resolve({ task: { createdAt: 't0', lastUpdatedAt: 't0', status: 'working', taskId: 'task-a', ttl: 60_000 } });
  }

  cancel(requestId: string): boolean {
    this.calls.push({ kind: 'cancel', requestId });
    return requestId === 'request-a';
  }

  cancelTask(options: { readonly taskId: string }): Promise<unknown> {
    this.calls.push({ kind: 'cancelTask', options });
    return Promise.resolve({ createdAt: 't0', lastUpdatedAt: 't1', status: 'cancelled', taskId: options.taskId, ttl: 60_000 });
  }

  getTask(options: { readonly taskId: string }): Promise<unknown> {
    this.calls.push({ kind: 'getTask', options });
    return Promise.resolve({ createdAt: 't0', lastUpdatedAt: 't0', status: 'working', taskId: options.taskId, ttl: 60_000 });
  }

  getTaskResult(options: { readonly taskId: string }): Promise<unknown> {
    this.calls.push({ kind: 'getTaskResult', options });
    return Promise.resolve({ content: [{ text: 'forecast', type: 'text' }] });
  }

  listTasks(options: { readonly cursor?: string }): Promise<unknown> {
    this.calls.push({ kind: 'listTasks', options });
    return Promise.resolve({ tasks: [] });
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
  ): McpSessionTraceSubscription {
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

it('admits one positive session timeout with the immutable session snapshot', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const created = await fetch(`${started.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: 'epoch-a', serverName: 'weather', target: 'portable', timeoutMs: 12_345 }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({
      session: {
        binding: { epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
        connection: service.session.connection,
        id: 'session-a',
        timeoutMs: 5_000,
      },
    });
    expect(service.opens).toEqual([{ epochId: 'epoch-a', serverName: 'weather', target: 'portable', timeoutMs: 12_345 }]);
  } finally {
    await started.close();
  }
});

it('maps a stale-epoch tool call failure to its fail-closed diagnostic', async () => {
  const service = new RecordingService();
  service.session.callToolError = new McpSessionStaleEpochError('epoch-a');
  const started = await startRoutes(service);

  try {
    const response = await fetch(`${started.url}/api/mcp/sessions/session-a/operations`, {
      body: JSON.stringify({ arguments: {}, name: 'forecast', operation: 'tools/call' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8018',
        message: 'MCP session epoch is no longer available; the project changed underneath the session.',
      },
    });
  } finally {
    await started.close();
  }
});

it('rejects invalid and smuggled session timeout request shapes', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const invalidBodies = [
      { epochId: 'epoch-a', serverName: 'weather', target: 'portable', timeoutMs: 0 },
      { epochId: 'epoch-a', serverName: 'weather', target: 'portable', timeoutMs: -1 },
      { epochId: 'epoch-a', serverName: 'weather', target: 'portable', timeoutMs: '5000' },
      { epochId: 'epoch-a', serverName: 'weather', target: 'portable', timeoutMs: [] },
      { epochId: 'epoch-a', serverName: 'weather', target: 'portable', timeoutMs: {} },
      { command: '/tmp/untrusted', epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
      { env: { TOKEN: 'untrusted' }, epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
      { headers: { authorization: 'untrusted' }, epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
    ];
    for (const body of invalidBodies) {
      const rejected = await fetch(`${started.url}/api/mcp/sessions`, {
        body: JSON.stringify(body),
        headers: { ...headers(), 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8016', message: 'MCP session request has an invalid shape.' },
      });
    }

    const prototypeSmuggling = await fetch(`${started.url}/api/mcp/sessions`, {
      body: '{"epochId":"epoch-a","serverName":"weather","target":"portable","__proto__":{"timeoutMs":12345}}',
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(prototypeSmuggling.status).toBe(400);
    await expect(prototypeSmuggling.json()).resolves.toEqual({
      diagnostic: { code: 'AB8016', message: 'MCP session request has an invalid shape.' },
    });

    const nonFinite = await fetch(`${started.url}/api/mcp/sessions`, {
      body: '{"epochId":"epoch-a","serverName":"weather","target":"portable","timeoutMs":1e999}',
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(nonFinite.status).toBe(400);
    await expect(nonFinite.json()).resolves.toEqual({
      diagnostic: { code: 'AB8016', message: 'MCP session request has an invalid shape.' },
    });
    expect(service.opens).toEqual([]);

    const synthetic = await fetch(`${started.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: 'epoch-a', serverName: 'weather', target: 'synthetic-mcp' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(synthetic.status).toBe(200);
    expect(service.opens).toEqual([{ epochId: 'epoch-a', serverName: 'weather', target: 'synthetic-mcp' }]);
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

it('routes the task operations (#369) as typed operations, rejecting malformed task shapes', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  const post = (body: unknown) => fetch(`${started.url}/api/mcp/sessions/session-a/operations`, {
    body: JSON.stringify(body),
    headers: { ...headers(), 'content-type': 'application/json' },
    method: 'POST',
  });

  try {
    const created = await post({ arguments: { holdMs: 50 }, name: 'forecast', operation: 'tools/call', requestId: 'request-task', task: { ttl: 60_000 } });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({ result: { task: expect.objectContaining({ status: 'working', taskId: 'task-a' }) } });
    expect(service.session.calls).toContainEqual({
      kind: 'callToolTask',
      options: { arguments: { holdMs: 50 }, name: 'forecast', requestId: 'request-task', task: { ttl: 60_000 } },
    });
    for (const [operation, kind] of [['tasks/get', 'getTask'], ['tasks/result', 'getTaskResult'], ['tasks/cancel', 'cancelTask']] as const) {
      const response = await post({ operation, taskId: 'task-a' });
      expect(response.status).toBe(200);
      expect(service.session.calls).toContainEqual({ kind, options: { taskId: 'task-a' } });
    }
    const listed = await post({ operation: 'tasks/list' });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ result: { tasks: [] } });
    expect(service.session.calls).toContainEqual({ kind: 'listTasks', options: {} });

    for (const malformed of [
      { arguments: {}, name: 'forecast', operation: 'tools/call', task: { ttl: -1 } },
      { arguments: {}, name: 'forecast', operation: 'tools/call', task: { later: true } },
      { operation: 'tasks/get' },
      { operation: 'tasks/get', taskId: '' },
      { cursor: 5, operation: 'tasks/list' },
    ]) {
      const rejected = await post(malformed);
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8016', message: 'MCP session request has an invalid shape.' },
      });
    }
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

    // The Workbench's run id rides `params._meta` so the frame joins the route
    // workspace's invocation on the unified trace; the browser never writes `_meta` itself.
    const correlated = await fetch(`${started.url}/api/mcp/sessions/session-a/operations`, {
      body: JSON.stringify({ arguments: {}, correlationId: 'corr-1', name: 'forecast', operation: 'tools/call' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(correlated.status).toBe(200);
    expect(service.session.calls).toContainEqual({
      kind: 'callTool',
      options: { _meta: { 'agent-bundle/correlationId': 'corr-1' }, arguments: {}, name: 'forecast' },
    });
    for (const malformed of [
      { arguments: {}, correlationId: '', name: 'forecast', operation: 'tools/call' },
      { arguments: {}, correlationId: 'c'.repeat(257), name: 'forecast', operation: 'tools/call' },
      { _meta: { 'agent-bundle/correlationId': 'corr-1' }, arguments: {}, name: 'forecast', operation: 'tools/call' },
    ]) {
      const invalid = await fetch(`${started.url}/api/mcp/sessions/session-a/operations`, {
        body: JSON.stringify(malformed),
        headers: { ...headers(), 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(invalid.status).toBe(400);
    }

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

it('streams a built MCP App resource frame without imposing a bundle-size cap', async () => {
  const service = new RecordingService();
  const payload = 'x'.repeat(2 * 1024 * 1024);
  const entry = { direction: 'server' as const, kind: 'frame' as const, message: { result: { contents: [{ text: payload }] } }, occurredAt: 1, sequence: 1 };
  service.session.queueReplay(entry);
  const started = await startRoutes(service);

  try {
    const stream = await fetch(`${started.url}/api/mcp/sessions/session-a/stream?after=0`, { headers: headers() });
    await expect(readLines(stream, 1)).resolves.toEqual([entry]);
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
