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
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
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
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'client',
      kind: 'frame',
      message: { id: 1, method: 'tools/list' },
      occurredAt: 100,
      sequence: 1,
    },
    type: 'trace',
  });
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'server',
      kind: 'frame',
      message: { id: 1, result: {} },
      occurredAt: 101,
      sequence: 1,
    },
    type: 'trace',
  });
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'server',
      kind: 'logging',
      occurredAt: 102,
      payload: { level: 'info', message: 'ready' },
      sequence: 0,
    },
    type: 'trace',
  });

  expect(model.timeline.lastSequence).toBe(1);
  expect(model.timeline.entries).toHaveLength(1);
  expect(model.diagnostics).toEqual([
    {
      code: 'mcp.trace.non-monotonic',
      message: 'Ignored trace sequence 1 because the current cursor is 1.',
      severity: 'warning',
    },
    {
      code: 'mcp.trace.non-monotonic',
      message: 'Ignored trace sequence 0 because the current cursor is 1.',
      severity: 'warning',
    },
  ]);
  expect(Object.isFrozen(model.diagnostics)).toBe(true);
});

it('retains raw protocol keys without allowing a __proto__ frame field to alter snapshot prototypes', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
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
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
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
  expect(Object.keys(model.activeRequests)).toEqual([]);

  model = reduceMcpBrowserSession(model, {
    diagnostic: { code: 'mcp.connect.failed', message: 'Connection lost.', severity: 'error' },
    type: 'failed',
  });
  expect(model.phase).toBe('closed');
  expect(model.diagnostics).toContainEqual({
    code: 'mcp.lifecycle.invalid-transition',
    message: 'Ignored failed while session phase is closed.',
    severity: 'warning',
  });
});

it('keeps the first active request handle and emits one stable duplicate diagnostic', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
  model = reduceMcpBrowserSession(model, { type: 'ready' });
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

it('treats prototype-like request IDs as normal handles and ignores unknown settlements without a phantom invocation', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
  model = reduceMcpBrowserSession(model, { type: 'ready' });
  model = reduceMcpBrowserSession(model, {
    completedAt: 4,
    id: 'toString',
    result: {},
    type: 'request.settled',
  });

  expect(model.timeline.entries).toEqual([]);
  expect(model.diagnostics).toContainEqual({
    code: 'mcp.request.unknown',
    message: 'Ignored settlement for unknown request toString.',
    severity: 'warning',
  });

  for (const id of ['toString', 'constructor', '__proto__']) {
    model = reduceMcpBrowserSession(model, {
      request: { id, operation: 'listTools', request: { id }, startedAt: 10 },
      type: 'request.start',
    });
  }

  expect(Object.getPrototypeOf(model.activeRequests)).toBeNull();
  expect(Object.keys(model.activeRequests)).toEqual(['toString', 'constructor', '__proto__']);
  for (const id of ['toString', 'constructor', '__proto__']) {
    model = reduceMcpBrowserSession(model, { completedAt: 11, id, result: { id }, type: 'request.settled' });
  }
  expect(invocationHistoryFor(model).map((entry) => entry.id)).toEqual(['toString', 'constructor', '__proto__']);
  expect(invocationHistoryFor(model).every((entry) => Number.isFinite(entry.timing.durationMs))).toBe(true);
});

it('rejects invalid JSON snapshots without mutating the model and preserves repeated aliases', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });

  for (const message of [cyclic, { value: Infinity }, { value: undefined }, { value: () => 'invalid' }]) {
    expect(() => reduceMcpBrowserSession(model, {
      entry: { direction: 'server', kind: 'frame', message, occurredAt: 1, sequence: 1 },
      type: 'trace',
    })).toThrow();
    expect(model.timeline.entries).toEqual([]);
  }

  const shared = { nested: true };
  model = reduceMcpBrowserSession(model, {
    entry: {
      direction: 'server', kind: 'frame', message: { first: shared, second: shared }, occurredAt: 1, sequence: 1,
    },
    type: 'trace',
  });
  const entry = model.timeline.entries[0];
  if (!('message' in entry) || entry.message === null || typeof entry.message !== 'object') throw new Error('Expected frame message.');
  const message = entry.message as { first: unknown; second: unknown };
  expect(message.first).toBe(message.second);
  expect(message.first).not.toBe(shared);
});

it('requires ordered explicit replay gaps and never accepts a frame inside a dropped range', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
  model = reduceMcpBrowserSession(model, {
    entry: { earliestAvailableSequence: 2, latestDroppedSequence: 1, requestedAfterSequence: 0, type: 'replay.gap' },
    type: 'trace',
  });

  expect(model.timeline.lastSequence).toBe(1);
  expect(Object.hasOwn(model.timeline, 'droppedThroughSequence')).toBe(true);
  model = reduceMcpBrowserSession(model, {
    entry: { direction: 'server', kind: 'frame', message: {}, occurredAt: 1, sequence: 1 },
    type: 'trace',
  });
  expect(model.timeline.entries).toHaveLength(1);
  expect(model.diagnostics).toContainEqual({
    code: 'mcp.trace.dropped',
    message: 'Ignored trace sequence 1 because it was dropped through 1.',
    severity: 'warning',
  });
  model = reduceMcpBrowserSession(model, {
    entry: { direction: 'server', kind: 'frame', message: {}, occurredAt: 2, sequence: 2 },
    type: 'trace',
  });
  expect(model.timeline.lastSequence).toBe(2);

  let missingGap = createMcpBrowserSessionModel('session-weather');
  missingGap = reduceMcpBrowserSession(missingGap, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
  missingGap = reduceMcpBrowserSession(missingGap, {
    entry: { direction: 'server', kind: 'frame', message: {}, occurredAt: 2, sequence: 2 },
    type: 'trace',
  });
  expect(missingGap.timeline.entries).toEqual([]);
  expect(missingGap.diagnostics).toContainEqual({
    code: 'mcp.trace.gap-required',
    message: 'Expected trace sequence 1 but received 2; an explicit replay gap is required.',
    severity: 'warning',
  });

  model = reduceMcpBrowserSession(model, {
    entry: { earliestAvailableSequence: 5, latestDroppedSequence: 3, requestedAfterSequence: 2, type: 'replay.gap' },
    type: 'trace',
  });
  expect(model.timeline.lastSequence).toBe(2);
  expect(model.diagnostics).toContainEqual({
    code: 'mcp.trace.invalid-replay-gap',
    message: 'Ignored replay gap after 2 because its retained range is invalid.',
    severity: 'warning',
  });
});

it('rejects all state-changing events after closing or closed phases', () => {
  let model = createMcpBrowserSessionModel('session-weather');
  model = reduceMcpBrowserSession(model, {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'claude' },
    type: 'open',
  });
  model = reduceMcpBrowserSession(model, { type: 'close' });
  model = reduceMcpBrowserSession(model, {
    catalogs: { prompts: [], resourceTemplates: [], resources: [], tools: [{ name: 'must-not-appear' }] },
    type: 'catalogs',
  });
  model = reduceMcpBrowserSession(model, { type: 'closed' });
  model = reduceMcpBrowserSession(model, {
    request: { id: 'late', operation: 'listTools', request: {}, startedAt: 1 },
    type: 'request.start',
  });

  expect(model.phase).toBe('closed');
  expect(model.catalogs.tools).toEqual([]);
  expect(Object.keys(model.activeRequests)).toEqual([]);
  expect(model.diagnostics).toContainEqual({
    code: 'mcp.lifecycle.invalid-transition',
    message: 'Ignored catalogs while session phase is closing.',
    severity: 'warning',
  });
  expect(model.diagnostics).toContainEqual({
    code: 'mcp.lifecycle.invalid-transition',
    message: 'Ignored request.start while session phase is closed.',
    severity: 'warning',
  });
});
