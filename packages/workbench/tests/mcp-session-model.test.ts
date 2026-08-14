import { expect, it } from '@rstest/core';

import {
  createMcpBrowserSessionModel,
  invocationHistoryFor,
  reduceMcpBrowserSession,
} from '../src/mcp/mcp-session-model.ts';

it('snapshots and freezes the selected session binding, connection, catalogs, and config', () => {
  const binding = { epochId: 'epoch-a', serverName: 'weather', target: 'claude' };
  const connection = {
    protocolVersion: '2026-06-18',
    serverCapabilities: { logging: {}, tools: { listChanged: true } },
    serverInfo: { name: 'weather', version: '1.0.0' },
  };
  const catalogs = {
    prompts: [{ name: 'forecast' }, { name: 'summary' }],
    resourceTemplates: [{ name: 'city', uriTemplate: 'weather://{city}' }],
    resources: [{ name: 'London', uri: 'weather://london' }],
    tools: [{ name: 'forecast' }, { name: 'alerts' }],
  };
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, { binding, type: 'open' });
  model = reduceMcpBrowserSession(model, { connection, type: 'connection' });
  model = reduceMcpBrowserSession(model, { catalogs, type: 'catalogs' });
  model = reduceMcpBrowserSession(model, {
    config: {
      launch: {
        args: ['server.mjs'],
        command: 'node',
        env: { API_TOKEN: 'do-not-display', LOG_LEVEL: 'debug' },
        kind: 'stdio',
      },
      origin: 'artifact',
    },
    type: 'config',
  });
  binding.epochId = 'mutated';
  connection.serverInfo.name = 'mutated';
  catalogs.tools[0].name = 'mutated';

  expect(model.phase).toBe('opening');
  expect(model.binding).toEqual({ epochId: 'epoch-a', serverName: 'weather', target: 'claude' });
  expect(model.connection).toEqual({
    protocolVersion: '2026-06-18',
    serverCapabilities: { logging: {}, tools: { listChanged: true } },
    serverInfo: { name: 'weather', version: '1.0.0' },
  });
  expect(model.catalogs.tools).toEqual([{ name: 'forecast' }, { name: 'alerts' }]);
  expect(model.config).toEqual({
    launch: {
      args: ['server.mjs'],
      command: 'node',
      env: { API_TOKEN: '[redacted]', LOG_LEVEL: 'debug' },
      kind: 'stdio',
    },
    origin: 'artifact',
  });
  expect(Object.isFrozen(model)).toBe(true);
  expect(Object.isFrozen(model.binding)).toBe(true);
  expect(Object.isFrozen(model.connection)).toBe(true);
  expect(Object.isFrozen(model.catalogs.tools)).toBe(true);
});

it('retains an ordered raw timeline with replay gaps and canonical invocation history', () => {
  const rawFrame = {
    direction: 'server' as const,
    kind: 'frame' as const,
    message: { jsonrpc: '2.0', result: { content: [{ text: 'Rain' }] } },
    occurredAt: 200,
    sequence: 2,
  };
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
  model = reduceMcpBrowserSession(model, {
    entry: { earliestAvailableSequence: 2, latestDroppedSequence: 1, requestedAfterSequence: 0, type: 'replay.gap' },
    type: 'trace',
  });
  model = reduceMcpBrowserSession(model, { entry: rawFrame, type: 'trace' });
  model = reduceMcpBrowserSession(model, {
    request: {
      id: 'call-1', operation: 'callTool', replayOf: 'call-0',
      request: { arguments: { city: 'London' }, name: 'forecast' }, startedAt: 100,
    },
    type: 'request.start',
  });
  model = reduceMcpBrowserSession(model, {
    completedAt: 160, id: 'call-1', result: { content: [{ text: 'Rain' }] }, type: 'request.settled',
  });
  rawFrame.message.result.content[0].text = 'mutated';

  expect(model.timeline.lastSequence).toBe(2);
  expect(model.timeline.entries).toEqual([
    {
      earliestAvailableSequence: 2,
      latestDroppedSequence: 1,
      requestedAfterSequence: 0,
      type: 'replay.gap',
    },
    {
      direction: 'server',
      kind: 'frame',
      message: { jsonrpc: '2.0', result: { content: [{ text: 'Rain' }] } },
      occurredAt: 200,
      sequence: 2,
    },
    expect.objectContaining({
      invocation: expect.objectContaining({
        binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
        replayOf: 'call-0',
        request: { arguments: { city: 'London' }, name: 'forecast' },
        result: { content: [{ text: 'Rain' }] },
        timing: { completedAt: 160, durationMs: 60, startedAt: 100 },
      }),
      type: 'invocation',
    }),
  ]);
  expect(invocationHistoryFor(model)).toEqual([
    expect.objectContaining({ id: 'call-1', operation: 'callTool' }),
  ]);
  expect(model.activeRequests).toEqual({});
  expect(Object.isFrozen(model.timeline.entries[1])).toBe(true);
});

it('redacts credentials and request-specific URL components from remote Inspector config', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    config: {
      launch: {
        kind: 'streamable-http',
        url: 'https://secret:password@mcp.example/v1?access_token=secret#fragment',
      },
      origin: 'artifact',
    },
    type: 'config',
  });

  expect(model.config).toEqual({
    launch: { kind: 'streamable-http', url: 'https://mcp.example/v1' },
    origin: 'artifact',
  });
});

it('keeps trace sequence monotonic and exposes stable diagnostics when an invalid update arrives', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'client',
      kind: 'frame',
      message: { id: 1, method: 'tools/list' },
      occurredAt: 100,
      sequence: 4,
    },
    type: 'trace',
  });
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'server',
      kind: 'frame',
      message: { id: 1, result: {} },
      occurredAt: 101,
      sequence: 4,
    },
    type: 'trace',
  });
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'server',
      kind: 'logging',
      occurredAt: 102,
      payload: { level: 'info', message: 'ready' },
      sequence: 3,
    },
    type: 'trace',
  });

  expect(model.timeline.lastSequence).toBe(4);
  expect(model.timeline.entries).toHaveLength(1);
  expect(model.diagnostics).toEqual([
    {
      code: 'mcp.trace.non-monotonic',
      message: 'Ignored trace sequence 4 because the current cursor is 4.',
      severity: 'warning',
    },
    {
      code: 'mcp.trace.non-monotonic',
      message: 'Ignored trace sequence 3 because the current cursor is 4.',
      severity: 'warning',
    },
  ]);
  expect(Object.isFrozen(model.diagnostics)).toBe(true);
});

it('retains raw protocol keys without allowing a __proto__ frame field to alter snapshot prototypes', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'server',
      kind: 'frame',
      message: JSON.parse('{"__proto__":{"polluted":true}}'),
      occurredAt: 1,
      sequence: 1,
    },
    type: 'trace',
  });

  const entry = model.timeline.entries[0];
  expect(entry).toMatchObject({ kind: 'frame' });
  if (!('message' in entry) || entry.message === null || typeof entry.message !== 'object') throw new Error('Expected frame message.');
  expect(Object.hasOwn(entry.message, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(entry.message)).toBe(Object.prototype);
});

it('derives concise, logging, and progress views from the single timeline', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    entry: { kind: 'logging', occurredAt: 1, payload: { message: 'connected' }, sequence: 1 },
    type: 'trace',
  });
  model = reduceMcpBrowserSession(model, {
    entry: { kind: 'progress', occurredAt: 2, payload: { progress: 1 }, sequence: 2 },
    type: 'trace',
  });

  expect(model.conciseTrace).toEqual(model.timeline.entries);
  expect(model.logs).toEqual([{ kind: 'logging', occurredAt: 1, payload: { message: 'connected' }, sequence: 1 }]);
  expect(model.progress).toEqual([{ kind: 'progress', occurredAt: 2, payload: { progress: 1 }, sequence: 2 }]);
});

it('models each explicit browser session lifecycle phase without retaining active requests after close', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'codex' },
    type: 'open',
  });
  model = reduceMcpBrowserSession(model, { type: 'ready' });
  model = reduceMcpBrowserSession(model, {
    request: {
      id: 'list-1',
      operation: 'listTools',
      request: {},
      startedAt: 1,
    },
    type: 'request.start',
  });
  expect(model.phase).toBe('ready');
  expect(model.activeRequests['list-1']).toMatchObject({ operation: 'listTools' });

  model = reduceMcpBrowserSession(model, { type: 'restart' });
  expect(model.phase).toBe('restarting');
  model = reduceMcpBrowserSession(model, { type: 'ready' });
  model = reduceMcpBrowserSession(model, { type: 'close' });
  expect(model.phase).toBe('closing');
  model = reduceMcpBrowserSession(model, { type: 'closed' });
  expect(model.phase).toBe('closed');
  expect(model.activeRequests).toEqual({});

  model = reduceMcpBrowserSession(model, {
    diagnostic: { code: 'mcp.connect.failed', message: 'Connection lost.', severity: 'error' },
    type: 'failed',
  });
  expect(model.phase).toBe('error');
  expect(model.diagnostics).toContainEqual({ code: 'mcp.connect.failed', message: 'Connection lost.', severity: 'error' });
});

it('keeps the first active request handle and emits one stable duplicate diagnostic', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    request: { id: 'request-1', operation: 'listTools', request: { first: true }, startedAt: 10 },
    type: 'request.start',
  });
  model = reduceMcpBrowserSession(model, {
    request: { id: 'request-1', operation: 'listTools', request: { second: true }, startedAt: 20 },
    type: 'request.start',
  });
  model = reduceMcpBrowserSession(model, {
    request: { id: 'request-1', operation: 'listTools', request: { second: true }, startedAt: 20 },
    type: 'request.start',
  });

  expect(model.activeRequests['request-1']).toMatchObject({ request: { first: true }, startedAt: 10 });
  expect(model.diagnostics).toEqual([
    {
      code: 'mcp.request.duplicate',
      message: 'Ignored duplicate active request request-1.',
      severity: 'warning',
    },
  ]);
});
