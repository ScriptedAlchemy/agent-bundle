import { describe, expect, it } from '@rstest/core';

import type { McpBrowserSessionModel } from '../src/mcp/mcp-session-model.ts';
import {
  inspectorLogEntries,
  inspectorProtocolEntries,
  inspectorSessionBindingKey,
  inspectorSessionTabs,
} from '../src/inspector/adapter/inspector-session-adapter-model.ts';

const model = {
  activeRequests: {},
  binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
  catalogs: {
    prompts: [{ description: 'A greeting', name: 'greet' }],
    resourceTemplates: [{ name: 'Forecast', uriTemplate: 'weather://{city}' }],
    resources: [{ name: 'Forecast', uri: 'weather://berlin' }],
    tools: [{ description: 'Returns weather.', inputSchema: { type: 'object' }, name: 'weather' }],
  },
  conciseTrace: [],
  connection: { protocolVersion: '2026-06-01' },
  diagnostics: [],
  logs: [],
  phase: 'ready',
  progress: [],
  sessionId: 'session-1',
  timeline: {
    droppedThroughSequence: 0,
    entries: [
      {
        direction: 'client',
        kind: 'frame',
        message: { id: 1, jsonrpc: '2.0', method: 'tools/list' },
        occurredAt: 1_700_000_000_001,
        sequence: 7,
      },
      {
        direction: 'server',
        kind: 'frame',
        message: { id: 1, jsonrpc: '2.0', result: { tools: [] } },
        occurredAt: 1_700_000_000_002,
        sequence: 8,
      },
      {
        kind: 'logging',
        occurredAt: 1_700_000_000_003,
        payload: { data: 'Connected', level: 'info' },
        sequence: 9,
      },
    ],
    lastSequence: 9,
  },
} as unknown as McpBrowserSessionModel;

describe('Inspector session adapter', () => {
  it('presents the immutable raw trace with its original sequence and timestamp', () => {
    const entries = inspectorProtocolEntries(model.timeline.entries);
    const logs = inspectorLogEntries(model.timeline.entries);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ direction: 'request', id: 'trace-7', sequence: 7 });
    expect(entries[0]!.timestamp.getTime()).toBe(1_700_000_000_001);
    expect(entries[1]).toMatchObject({ direction: 'response', id: 'trace-8', sequence: 8 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ receivedAt: new Date(1_700_000_000_003), sequence: 9 });
    expect(logs[0]!.params).toEqual({ data: 'Connected', level: 'info' });
  });

  it('uses the exact artifact binding as the scroll-memory boundary', () => {
    expect(inspectorSessionBindingKey(model.binding)).toBe('epoch-1\u0000codex\u0000weather');
    expect(inspectorSessionBindingKey({ ...model.binding!, serverName: 'calendar' })).not.toBe(
      inspectorSessionBindingKey(model.binding),
    );
  });

  it('exposes only the bounded Inspector screen set', () => {
    expect(inspectorSessionTabs.map((tab) => tab.label)).toEqual([
      'Tools',
      'Resources',
      'Prompts',
      'Protocol',
      'Logging',
    ]);
  });
});
