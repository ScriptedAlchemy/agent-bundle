import { expect, it } from '@rstest/core';

import { mcpCorrelationMetaKey } from '../src/contracts/mcp-session.ts';
import type { McpSessionBinding, McpSessionTraceEntry } from '../src/dev/mcp-session/mcp-session-protocol.ts';
import { composeMcpSessionTraceSinks, McpSessionTraceLog } from '../src/dev/mcp-session/mcp-session-trace.ts';
import {
  createMcpSessionTraceSink,
  liftMcpFrame,
} from '../src/dev/mcp-session/mcp-session-trace-publisher.ts';
import type { TraceEntry, TraceEntryInput } from '../src/dev/trace/trace-entry.ts';
import type { TracePublisher } from '../src/dev/trace/trace-hub.ts';

const binding: McpSessionBinding = Object.freeze({ epochId: 'epoch-7', serverName: 'curator', target: 'claude' });
const projectRoot = '/home/dev/projects/curator';
const sessionId = 'sess-1';

const fakePublisher = (): TracePublisher & { readonly published: TraceEntryInput[] } => {
  const published: TraceEntryInput[] = [];
  return {
    published,
    publish(input) {
      published.push(input);
      return { ...input, id: `trc_${published.length}`, occurredAt: input.occurredAt ?? 'now', sequence: published.length } as TraceEntry;
    },
  };
};

let sequence = 0;

const frame = (direction: 'client' | 'server', message: unknown, occurredAt: number): McpSessionTraceEntry => Object.freeze({
  direction,
  ...liftMcpFrame(message),
  kind: 'frame',
  message,
  occurredAt,
  sequence: ++sequence,
});

const operation = (
  operation: 'close' | 'initialize' | 'listTools' | 'restart',
  phase: 'failed' | 'started' | 'succeeded',
  occurredAt = 1_000,
): McpSessionTraceEntry => Object.freeze({ kind: 'operation', occurredAt, operation, phase, sequence: ++sequence });

it('lifts the JSON-RPC id, method, and host correlation keys off a frame without translating it', () => {
  expect(liftMcpFrame('not an object')).toEqual({});
  expect(liftMcpFrame({ id: 4, jsonrpc: '2.0', result: {} })).toEqual({ id: '4' });
  expect(liftMcpFrame({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ method: 'notifications/initialized' });
  expect(liftMcpFrame({
    id: 'req-a',
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      _meta: {
        [mcpCorrelationMetaKey]: 'corr-1',
        'claudecode/toolUseId': 'toolu_01',
        progressToken: 9,
        'x-codex-turn-metadata': { session_id: 'codex-session', thread_id: 'thread-a', turn_id: 'turn-3' },
      },
      name: 'search',
    },
  })).toEqual({
    id: 'req-a',
    meta: { correlationId: 'corr-1', conversationId: 'thread-a', requestId: 'toolu_01', sessionId: 'codex-session' },
    method: 'tools/call',
  });
  expect(liftMcpFrame({ id: 1.5, method: 'x'.repeat(300), params: { _meta: { 'claudecode/toolUseId': 'bad\u0000id' } } })).toEqual({});
});

it('lowers a tools/call request and its response onto the trace, paired by id with the route and duration', () => {
  const trace = fakePublisher();
  const sink = createMcpSessionTraceSink({ binding, projectRoot, sessionId, trace });
  sink(binding, frame('client', {
    id: 7,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { _meta: { 'claudecode/toolUseId': 'toolu_01', [mcpCorrelationMetaKey]: 'corr-9' }, arguments: { query: 'jazz' }, name: 'search' },
  }, 10_000));
  sink(binding, frame('server', { id: 7, jsonrpc: '2.0', result: { content: [], structuredContent: { hits: 3 } } }, 10_250));

  expect(trace.published).toHaveLength(2);
  const [request, response] = trace.published;
  expect(request).toMatchObject({
    correlation: {
      correlationId: 'corr-9',
      epochId: 'epoch-7',
      host: 'claude',
      mcpRequestId: '7',
      mcpSessionId: sessionId,
      requestId: 'toolu_01',
      routeId: 'tool:curator/search',
    },
    details: { method: 'tools/call', name: 'search' },
    href: '/routes/mcp/curator/tool/search?session=sess-1',
    kind: 'mcp.request',
    occurredAt: new Date(10_000).toISOString(),
    source: 'mcp',
    status: 'running',
    summary: 'tools/call search',
  });
  expect((request?.details as { readonly paramsBytes: number }).paramsBytes).toBeGreaterThan(0);
  expect(response).toMatchObject({
    correlation: request?.correlation,
    durationMs: 250,
    href: '/routes/mcp/curator/tool/search?session=sess-1',
    kind: 'mcp.response',
    status: 'ok',
    summary: 'tools/call search ok',
  });
  expect(response?.details).not.toHaveProperty('structuredContent');
});

it('marks JSON-RPC errors and tool errors, redacts error text, and links unrouted frames to the protocol page', () => {
  const trace = fakePublisher();
  const sink = createMcpSessionTraceSink({ binding, projectRoot, sessionId, trace });
  sink(binding, frame('client', { id: 'a', jsonrpc: '2.0', method: 'resources/read', params: { uri: 'ui://x/y' } }, 1));
  sink(binding, frame('server', { error: { code: -32602, message: `missing ${projectRoot}/src/secret.ts` }, id: 'a', jsonrpc: '2.0' }, 5));
  sink(binding, frame('client', { id: 'b', jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'inspect' } }, 6));
  sink(binding, frame('server', { id: 'b', jsonrpc: '2.0', result: { content: [], isError: true } }, 9));
  sink(binding, frame('server', { id: 'orphan', jsonrpc: '2.0', result: {} }, 10));

  expect(trace.published.map((entry) => [entry.kind, entry.status, entry.summary, entry.href])).toEqual([
    ['mcp.request', 'running', 'resources/read', '/advanced/protocol?session=sess-1'],
    ['mcp.response', 'error', 'resources/read error -32602', '/advanced/protocol?session=sess-1'],
    ['mcp.request', 'running', 'tools/call inspect', '/routes/mcp/curator/tool/inspect?session=sess-1'],
    ['mcp.response', 'error', 'tools/call inspect tool error', '/routes/mcp/curator/tool/inspect?session=sess-1'],
    ['mcp.response', 'ok', 'response ok', '/advanced/protocol?session=sess-1'],
  ]);
  const failed = trace.published[1]?.details as { readonly error: { readonly code: number; readonly message: string } };
  expect(failed.error.code).toBe(-32602);
  expect(failed.error.message).not.toContain(projectRoot);
  expect(trace.published[1]?.durationMs).toBe(4);
  expect(trace.published[4]).not.toHaveProperty('durationMs');
  expect(trace.published[4]?.correlation).toEqual({ epochId: 'epoch-7', host: 'claude', mcpRequestId: 'orphan', mcpSessionId: sessionId });
});

it('lowers notifications, progress, logging, and stderr once each without raw payloads', () => {
  const trace = fakePublisher();
  const sink = createMcpSessionTraceSink({ binding, projectRoot, sessionId, trace });
  sink(binding, frame('client', { jsonrpc: '2.0', method: 'notifications/initialized' }, 1));
  sink(binding, frame('client', {
    id: 3,
    jsonrpc: '2.0',
    method: 'prompts/get',
    params: { _meta: { progressToken: 'tok-3' }, name: 'brief' },
  }, 2));
  const progressFrame = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 2, progressToken: 'tok-3', total: 5 } };
  sink(binding, frame('server', progressFrame, 3));
  sink(binding, Object.freeze({ kind: 'progress', occurredAt: 3, payload: progressFrame.params, sequence: ++sequence }));
  const loggingFrame = { jsonrpc: '2.0', method: 'notifications/message', params: { data: { secret: 'value' }, level: 'warning', logger: 'fixture' } };
  sink(binding, frame('server', loggingFrame, 4));
  sink(binding, Object.freeze({ kind: 'logging', occurredAt: 4, payload: loggingFrame.params, sequence: ++sequence }));
  sink(binding, Object.freeze({ kind: 'stderr', occurredAt: 5, sequence: ++sequence, text: `failed to load ${projectRoot}/dist/server.js line 12\nsecond line\n` }));
  sink(binding, frame('client', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { reason: 'user', requestId: 3 } }, 6));

  expect(trace.published.map((entry) => [entry.kind, entry.summary])).toEqual([
    ['mcp.notification', 'notifications/initialized'],
    ['mcp.request', 'prompts/get brief'],
    ['mcp.progress', 'progress 2/5'],
    ['mcp.logging', 'log warning fixture'],
    ['mcp.stderr', 'stderr: failed to load <project>/dist/server.js line 12'],
    ['mcp.notification', 'notifications/cancelled'],
  ]);
  expect(trace.published[2]?.correlation).toMatchObject({ mcpRequestId: '3', routeId: 'prompt:curator/brief' });
  expect(trace.published[2]?.href).toBe('/routes/mcp/curator/prompt/brief?session=sess-1');
  expect(trace.published[3]?.details).toEqual({ level: 'warning', logger: 'fixture' });
  expect(trace.published[4]?.details).toEqual({ bytes: Buffer.byteLength(`failed to load ${projectRoot}/dist/server.js line 12\nsecond line\n`) });
  expect(trace.published[5]?.correlation).toMatchObject({ mcpRequestId: '3', routeId: 'prompt:curator/brief' });
});

it('publishes session started and closed once from the lifecycle operations and nothing for catalog operations', () => {
  const trace = fakePublisher();
  const sink = createMcpSessionTraceSink({ binding, projectRoot, sessionId, trace });
  sink(binding, operation('initialize', 'started'));
  sink(binding, operation('initialize', 'succeeded', 2_000));
  sink(binding, operation('initialize', 'succeeded', 2_500));
  sink(binding, operation('listTools', 'started'));
  sink(binding, operation('listTools', 'succeeded'));
  sink(binding, operation('restart', 'succeeded', 3_000));
  sink(binding, operation('close', 'started'));
  sink(binding, operation('close', 'failed', 4_000));
  sink(binding, operation('close', 'succeeded', 4_100));

  expect(trace.published.map((entry) => [entry.kind, entry.status, entry.summary, entry.occurredAt])).toEqual([
    ['mcp.session.started', 'ok', 'MCP session curator (claude) started', new Date(2_000).toISOString()],
    ['mcp.session.started', 'ok', 'MCP session curator (claude) restarted', new Date(3_000).toISOString()],
    ['mcp.session.closed', 'error', 'MCP session curator (claude) closed with cleanup failure', new Date(4_000).toISOString()],
  ]);
  expect(trace.published.every((entry) => entry.href === '/advanced/protocol?session=sess-1')).toBe(true);
  expect(trace.published.every((entry) => entry.correlation.mcpSessionId === sessionId && entry.correlation.host === 'claude')).toBe(true);
});

it('resolves a lazy sessionId per frame and lets a frame _meta sessionId win', () => {
  const resolved: string[] = [];
  let current = 'hs_0123456789abcdef';
  const trace = fakePublisher();
  const sink = createMcpSessionTraceSink({
    binding,
    projectRoot,
    resolveSessionId: () => {
      resolved.push(current);
      return current;
    },
    sessionId,
    trace,
  });
  sink(binding, frame('client', { id: 1, jsonrpc: '2.0', method: 'tools/list' }, 1));
  current = 'codex-session';
  sink(binding, frame('client', {
    id: 2,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { _meta: { 'x-codex-turn-metadata': { session_id: 'meta-session' } }, arguments: {}, name: 'search' },
  }, 2));
  sink(binding, Object.freeze({ kind: 'logging', occurredAt: 3, payload: { level: 'info' }, sequence: ++sequence }));

  expect(resolved).toHaveLength(3);
  expect(trace.published[0]?.correlation.sessionId).toBe('hs_0123456789abcdef');
  expect(trace.published[1]?.correlation.sessionId).toBe('meta-session');
  expect(trace.published[2]?.correlation.sessionId).toBe('codex-session');
});

it('isolates a throwing trace publisher from the session trace log and its sibling sinks', () => {
  const seen: McpSessionTraceEntry[] = [];
  const throwing: TracePublisher = {
    publish() {
      throw new Error('trace hub is closed');
    },
  };
  const composed = composeMcpSessionTraceSinks(
    undefined,
    (_binding, entry) => {
      seen.push(entry);
    },
    createMcpSessionTraceSink({ binding, projectRoot, sessionId, trace: throwing }),
  );
  expect(composed).toBeDefined();
  const log = new McpSessionTraceLog(binding, composed);
  const delivered: McpSessionTraceEntry[] = [];
  log.subscribe({}, (message) => {
    if ('kind' in message) delivered.push(message);
  });
  const entry = frame('client', { id: 1, jsonrpc: '2.0', method: 'tools/list' }, 1);
  expect(() => log.record(entry)).not.toThrow();
  expect(seen).toEqual([entry]);
  expect(delivered).toEqual([entry]);
  expect(log.replay().entries).toEqual([entry]);

  const only = (_binding: McpSessionBinding, _entry: McpSessionTraceEntry): void => undefined;
  expect(composeMcpSessionTraceSinks(undefined, undefined)).toBeUndefined();
  expect(composeMcpSessionTraceSinks(only)).toBe(only);
});
