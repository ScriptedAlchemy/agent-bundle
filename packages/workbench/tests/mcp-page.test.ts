import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import type { McpSessionInspectorConfig } from '../../agent-bundle/src/dev/mcp-session-protocol.ts';
import { createMcpBrowserSessionModel, reduceMcpBrowserSession, type McpBrowserSessionModel } from '../src/mcp/mcp-session-model.ts';
import type { McpAppPreviewClient } from '../src/mcp/mcp-app-preview.tsx';
import {
  McpPage,
  createMcpPageActionTracker,
  createMcpPageActionSession,
  mcpConfigDownload,
  mcpAppPreviewSourceFor,
  mcpPageControllerReplacementState,
  mcpPageSessionControls,
  supportedMcpAppPreviewProfiles,
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

const appPreviewClient: McpAppPreviewClient = {
  close: async () => ({ lifecycle: 'closed' }),
  create: async () => ({
    bindingId: 'binding-weather',
    profile: { kind: 'apps', profile: 'portable', resourceUri: 'ui://weather/forecast.html' },
    resource: { html: '<main>Forecast</main>', kind: 'resource' },
  }),
  forceClose: async () => true,
  message: async () => ({ accepted: true, lifecycle: 'initialized', messages: [] }),
};

const reducedModelForConfig = (config: McpSessionInspectorConfig): McpBrowserSessionModel => {
  const opening = reduceMcpBrowserSession(createMcpBrowserSessionModel('sanitized-session'), {
    binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
    type: 'open',
  });
  const configured = reduceMcpBrowserSession(opening, { config, type: 'config' });
  return reduceMcpBrowserSession(configured, { type: 'ready' });
};

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

  it('renders one labeled session timeout control beside the immutable open binding', () => {
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: controller(),
      epochOptions: ['epoch-1'],
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('for="mcp-session-timeout"');
    expect(markup).toContain('Session timeout (ms)');
    expect(markup).toContain('id="mcp-session-timeout"');
    expect(markup).toContain('value="5000"');
  });

  it('creates a named JSON blob for the injected config-download callback', async () => {
    const download = mcpConfigDownload(model.config!, model.sessionId);

    expect(download.filename).toBe('mcp-session-1-inspector.json');
    expect(download.blob.type).toBe('application/json');
    await expect(download.blob.text()).resolves.toContain('"command": "node"');
  });

  it('renders the sanitized stdio launch configuration in deterministic environment order', () => {
    const session = reducedModelForConfig({
      launch: {
        args: ['server.mjs', '--watch'],
        command: 'node',
        cwd: '/workspace/weather',
        env: { ZEBRA: 'last', API_TOKEN: 'foreground-secret', ALPHA: 'first' },
        kind: 'stdio',
      },
      origin: 'artifact',
    });
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: { ...controller(), model: session },
      epochOptions: ['epoch-1'],
      onDownloadConfig: () => undefined,
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('Launch configuration');
    expect(markup).toContain('stdio');
    expect(markup).toContain('node');
    expect(markup).toContain('server.mjs');
    expect(markup).toContain('--watch');
    expect(markup).toContain('/workspace/weather');
    expect(markup.indexOf('ALPHA')).toBeLessThan(markup.indexOf('ZEBRA'));
    expect(markup).toContain('API_TOKEN');
    expect(markup).toContain('[redacted]');
    expect(markup).not.toContain('foreground-secret');
  });

  it('renders empty stdio launch fields explicitly', () => {
    const session = reducedModelForConfig({
      launch: { args: [], command: 'node', env: {}, kind: 'stdio' },
      origin: 'artifact',
    });
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: { ...controller(), model: session },
      epochOptions: ['epoch-1'],
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('No arguments specified.');
    expect(markup).toContain('Not specified');
    expect(markup).toContain('No environment variables specified.');
  });

  it('renders only the sanitized streamable HTTP transport details', () => {
    const session = reducedModelForConfig({
      launch: { kind: 'streamable-http', url: 'https://username:password@mcp.example.test/launch?token=query-secret#fragment-secret' },
      origin: 'artifact',
    });
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: { ...controller(), model: session },
      epochOptions: ['epoch-1'],
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('Launch configuration');
    expect(markup).toContain('streamable-http');
    expect(markup).toContain('https://mcp.example.test/launch');
    expect(markup).not.toContain('username');
    expect(markup).not.toContain('password');
    expect(markup).not.toContain('query-secret');
    expect(markup).not.toContain('fragment-secret');
    expect(markup).not.toContain('Launch arguments');
    expect(markup).not.toContain('Launch environment');
  });

  it('renders a clear empty launch configuration state when the controller has none', () => {
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: { ...controller(), model: { ...model, config: undefined } },
      epochOptions: ['epoch-1'],
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('Launch configuration');
    expect(markup).toContain('No launch configuration is available for this session.');
  });

  it('derives an App preview only from the current successful tool invocation', () => {
    const invocation = controller().history[0]!;

    expect(supportedMcpAppPreviewProfiles).toEqual(['portable', 'chatgpt', 'claude']);
    expect(mcpAppPreviewSourceFor({ phase: 'ready', sessionId: 'session-1' }, invocation)).toEqual({
      input: { city: 'Oslo' },
      invocationId: 'previous-tool-call',
      result: { content: [{ text: 'Cloudy', type: 'text' }] },
      sessionId: 'session-1',
      toolName: 'weather',
    });
    expect(mcpAppPreviewSourceFor({ phase: 'closed', sessionId: 'session-1' }, invocation)).toBeUndefined();
    expect(mcpAppPreviewSourceFor({ phase: 'ready', sessionId: 'session-2' }, {
      ...invocation,
      operation: 'readResource',
    })).toBeUndefined();
    expect(mcpAppPreviewSourceFor({ phase: 'ready', sessionId: 'session-2' }, {
      ...invocation,
      error: { message: 'tool failure' },
    })).toBeUndefined();
  });

  it('renders an explicit supported-profile picker and history preview entry point', () => {
    const markup = renderToStaticMarkup(createElement(McpPage, {
      appPreviewClient,
      controller: { ...controller(), model: { ...model, phase: 'ready' } },
      epochOptions: ['epoch-1'],
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('aria-label="MCP App preview controls"');
    expect(markup).toContain('id="mcp-app-profile"');
    expect(markup).toContain('<option value="portable" selected="">portable</option>');
    expect(markup).toContain('<option value="chatgpt">chatgpt</option>');
    expect(markup).toContain('<option value="claude">claude</option>');
    expect(markup).toContain('Open App preview for previous-tool-call');
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

  it('keeps a new stuck open pending after terminal reset ignores delayed old open cleanup', () => {
    const actions = createMcpPageActionSession();
    const oldOpen = actions.start('open');

    expect(oldOpen).toBeDefined();
    actions.reset();
    const newOpen = actions.start('open');

    expect(actions.isCurrent(oldOpen!)).toBe(false);
    expect(actions.finish(oldOpen!)).toBeUndefined();
    expect(actions.pending).toEqual(['open']);
    expect(actions.isCurrent(newOpen!)).toBe(true);
    expect(mcpPageSessionControls('idle', actions.pending, false)).toMatchObject({ close: true, open: false });
  });

  it('clears existing transient error state when the parent injects a replacement controller', () => {
    const replacement = mcpPageControllerReplacementState();

    expect(replacement.actionError).toBeUndefined();
    expect(replacement.cancelledRequests).toEqual([]);
    expect(replacement.pendingActions).toEqual([]);
  });

  it('rejects a delayed old rejection after synchronous controller-generation replacement', () => {
    const actions = createMcpPageActionSession();
    const oldOpen = actions.start('open')!;
    let actionError: string | undefined;

    actions.reset();
    const replacementOpen = actions.start('open')!;
    if (actions.isCurrent(oldOpen)) actionError = 'old open rejected';

    expect(actionError).toBeUndefined();
    expect(actions.finish(oldOpen)).toBeUndefined();
    expect(actions.pending).toEqual(['open']);
    expect(actions.isCurrent(replacementOpen)).toBe(true);
    expect(mcpPageSessionControls('idle', actions.pending, false)).toMatchObject({ close: true, open: false });
  });
});
