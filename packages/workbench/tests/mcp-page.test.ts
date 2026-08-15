import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import type { McpBrowserSessionModel } from '../src/mcp/mcp-session-model.ts';
import {
  McpPage,
  createMcpPageActionTracker,
  mcpConfigDownload,
  mcpPageSessionControls,
  type McpPageController,
} from '../src/mcp/mcp-page.tsx';

const model = {
  activeRequests: {
    'tool-call-1': {
      id: 'tool-call-1',
      operation: 'callTool',
      request: { arguments: { city: 'Berlin' }, name: 'weather' },
      startedAt: 1_700_000_000_000,
    },
  },
  binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
  catalogs: {
    prompts: [{ description: 'A greeting', name: 'greet' }],
    resourceTemplates: [{ name: 'Forecast', uriTemplate: 'weather://{city}' }],
    resources: [{ name: 'Forecasts', uri: 'weather://berlin' }],
    tools: [
      {
        description: 'Returns weather for a city.',
        inputSchema: {
          properties: { city: { type: 'string' } },
          required: ['city'],
          type: 'object',
        },
        name: 'weather',
      },
      { description: 'Returns server time.', name: 'clock' },
    ],
  },
  conciseTrace: [{ direction: 'server', kind: 'frame', message: { result: {} }, occurredAt: 1_700_000_000_001, sequence: 1 }],
  config: {
    launch: { args: ['server.mjs'], command: 'node', env: { SAFE: 'true' }, kind: 'stdio' },
    origin: 'artifact',
  },
  connection: { protocolVersion: '2025-06-18', serverCapabilities: { tools: {} }, serverInfo: { name: 'Weather Server' } },
  diagnostics: [{ code: 'mcp.trace.delayed', message: 'Trace delivery is delayed.', severity: 'warning' }],
  logs: [{ kind: 'logging', occurredAt: 1_700_000_000_002, payload: { level: 'info', message: 'Connected' }, sequence: 2 }],
  phase: 'idle',
  progress: [{ kind: 'progress', occurredAt: 1_700_000_000_003, payload: { progress: 1 }, sequence: 3 }],
  sessionId: 'session-1',
  timeline: {
    droppedThroughSequence: 0,
    entries: [{ direction: 'server', kind: 'frame', message: { result: {} }, occurredAt: 1_700_000_000_001, sequence: 1 }],
    lastSequence: 3,
  },
} as unknown as McpBrowserSessionModel;

const controller = (): McpPageController => ({
  cancel: () => true,
  close: async () => undefined,
  history: [{
    id: 'previous-tool-call',
    operation: 'callTool',
    request: { arguments: { city: 'Oslo' }, name: 'weather' },
    result: { content: [{ text: 'Cloudy', type: 'text' }] },
    timing: { completedAt: 1_700_000_000_010, durationMs: 5, startedAt: 1_700_000_000_005 },
  }],
  invoke: async () => ({ content: [] }),
  model,
  open: async () => model,
  replay: async () => ({ content: [] }),
  restart: async () => model,
  subscribe: (listener) => {
    listener(model);
    return () => undefined;
  },
});

describe('MCP page', () => {
  it('renders the epoch-bound lifecycle, ordered catalog, operations, history, and one accessible trace view', () => {
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: controller(),
      epochOptions: ['epoch-1', 'epoch-2'],
      onDownloadConfig: () => undefined,
      targetOptions: ['codex', 'claude'],
    }));

    expect(markup).toContain('aria-label="MCP playground"');
    expect(markup).toContain('id="mcp-epoch"');
    expect(markup).toContain('id="mcp-target"');
    expect(markup).toContain('id="mcp-server-name"');
    expect(markup).toContain('required=""');
    expect(markup).toContain('Open MCP session');
    expect(markup).toContain('Restart MCP session');
    expect(markup).toContain('Close MCP session');
    expect(markup).toContain('Cancel tool-call-1');
    expect(markup).toContain('Protocol 2025-06-18');
    expect(markup).toContain('Weather Server');
    expect(markup.indexOf('weather')).toBeLessThan(markup.indexOf('clock'));
    expect(markup).toContain('Tool arguments');
    expect(markup).toContain('Prompt arguments');
    expect(markup).toContain('Read weather://berlin');
    expect(markup).toContain('List tools');
    expect(markup).toContain('Replay previous-tool-call');
    expect(markup).toContain('Raw protocol');
    expect(markup).toContain('Logs');
    expect(markup).toContain('Progress');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('Download Inspector config');
    expect(markup).toContain('Trace delivery is delayed.');
  });

  it('creates a named JSON blob for the injected config-download callback', async () => {
    const download = mcpConfigDownload(model.config!, model.sessionId);

    expect(download.filename).toBe('mcp-session-1-inspector.json');
    expect(download.blob.type).toBe('application/json');
    await expect(download.blob.text()).resolves.toContain('"command": "node"');
  });

  it('tracks interactions independently so cancellation and close recovery remain available', () => {
    const actions = createMcpPageActionTracker();

    expect(actions.start('invoke:listTools')).toBe(true);
    expect(actions.start('invoke:listTools')).toBe(false);
    expect(actions.isPending('cancel:tool-call-1')).toBe(false);
    expect(mcpPageSessionControls('ready', actions.pending, false).close).toBe(true);

    actions.finish('invoke:listTools');
    expect(actions.start('open')).toBe(true);
    expect(mcpPageSessionControls('idle', actions.pending, false)).toMatchObject({ close: true, open: false });

    actions.finish('open');
    expect(actions.start('restart')).toBe(true);
    expect(mcpPageSessionControls('restarting', actions.pending, false).close).toBe(true);
  });

  it('does not advertise a dead open path after the controller reaches a terminal phase', () => {
    expect(mcpPageSessionControls('idle', [], false)).toMatchObject({ open: true, recovery: 'none' });
    expect(mcpPageSessionControls('closed', [], false)).toMatchObject({ open: false, recovery: 'unavailable' });
    expect(mcpPageSessionControls('error', [], true)).toMatchObject({ open: false, recovery: 'available' });
  });
});
