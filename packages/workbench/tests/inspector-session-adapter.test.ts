import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, rs } from '@rstest/core';

import type { McpBrowserSessionModel } from '../src/mcp/mcp-session-model.ts';
import {
  inspectorLogEntries,
  inspectorProtocolEntries,
  inspectorSessionBindingKey,
  inspectorSessionTabs,
} from '../src/inspector/adapter/inspector-session-adapter-model.ts';
import {
  InspectorSessionAdapter,
  agentBundleInspectorTheme,
} from '../src/inspector/adapter/inspector-session-adapter.tsx';

const screens = rs.hoisted(() => ({
  logging: undefined as undefined | Record<string, unknown>,
  prompts: undefined as undefined | Record<string, unknown>,
  protocol: undefined as undefined | Record<string, unknown>,
  resources: undefined as undefined | Record<string, unknown>,
  tools: undefined as undefined | Record<string, unknown>,
}));

rs.mock('../src/inspector/adapter/vendor-screens.jsx', () => ({
  LoggingScreen: (props: Record<string, unknown>) => { screens.logging = props; return 'logging-screen'; },
  PromptsScreen: (props: Record<string, unknown>) => { screens.prompts = props; return 'prompts-screen'; },
  ProtocolScreen: (props: Record<string, unknown>) => { screens.protocol = props; return 'protocol-screen'; },
  ResourcesScreen: (props: Record<string, unknown>) => { screens.resources = props; return 'resources-screen'; },
  ToolsScreen: (props: Record<string, unknown>) => { screens.tools = props; return 'tools-screen'; },
}));

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
        direction: 'server',
        kind: 'frame',
        message: { id: 1, jsonrpc: '2.0', method: 'initialize' },
        occurredAt: 1_700_000_000_001,
        sequence: 7,
      },
      {
        direction: 'client',
        kind: 'frame',
        message: { id: 1, jsonrpc: '2.0', result: { capabilities: {} } },
        occurredAt: 1_700_000_000_002,
        sequence: 8,
      },
      {
        direction: 'server',
        kind: 'frame',
        message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
        occurredAt: 1_700_000_000_003,
        sequence: 9,
      },
      {
        kind: 'logging',
        occurredAt: 1_700_000_000_004,
        payload: { data: 'Connected', level: 'info' },
        sequence: 10,
      },
      {
        direction: 'client',
        kind: 'frame',
        message: { id: 2, jsonrpc: '2.0', method: 'tools/call' },
        occurredAt: 1_700_000_000_005,
        sequence: 11,
      },
    ],
    lastSequence: 11,
  },
} as unknown as McpBrowserSessionModel;

describe('Inspector session adapter', () => {
  it('presents the immutable raw trace with its original sequence and timestamp', () => {
    const entries = inspectorProtocolEntries(model.timeline.entries);
    const logs = inspectorLogEntries(model.timeline.entries);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ direction: 'request', id: 'trace-7', sequence: 7 });
    expect(entries[0]!.timestamp.getTime()).toBe(1_700_000_000_001);
    expect(entries[1]).toMatchObject({ direction: 'response', id: 'trace-8', sequence: 8 });
    expect(entries[2]).toMatchObject({ direction: 'notification', id: 'trace-9', origin: 'server', sequence: 9 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ receivedAt: new Date(1_700_000_000_004), sequence: 10 });
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

  it('renders the adapter-owned theme and routes screen callbacks without vendor changes', async () => {
    const controller = {
      cancel: rs.fn(),
      invoke: rs.fn(async () => ({ content: [] })),
    };
    const markup = renderToStaticMarkup(createElement(InspectorSessionAdapter, { controller, model }));

    expect(markup).toContain('MCP Inspector presentation');
    expect(markup).toContain('Negotiated protocol: 2026-06-01');
    expect(markup).toContain('tools-screen');
    expect(agentBundleInspectorTheme.primaryColor).toBe('violet');
    expect(screens.tools).toBeDefined();

    const onCallTool = screens.tools!.onCallTool as (name: string, args: Record<string, unknown>) => void;
    onCallTool('weather', { city: 'Berlin' });
    await Promise.resolve();
    expect(controller.invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: 'callTool',
      request: { arguments: { city: 'Berlin' }, name: 'weather' },
    }));

    renderToStaticMarkup(createElement(InspectorSessionAdapter, { controller, initialTab: 'logging', model }));
    expect(screens.logging).toBeDefined();
    expect(screens.logging!.onSetLevel).toBeTypeOf('function');

    renderToStaticMarkup(createElement(InspectorSessionAdapter, { controller, initialTab: 'protocol', model }));
    expect(screens.protocol).toBeDefined();
    expect(screens.protocol!.entries).toHaveLength(3);
    expect(screens.logging!.embedded).toBe(true);
    expect(markup).not.toContain('Set Active Level');
  });
});
