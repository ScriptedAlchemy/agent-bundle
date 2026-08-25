import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import type { McpSessionInspectorConfig } from '../../agent-bundle/src/dev/mcp-session/mcp-session-protocol.ts';
import {
  createMcpBrowserSessionModel,
  reduceMcpBrowserSession,
  type McpBrowserSessionInvocation,
  type McpBrowserSessionModel,
} from '../src/mcp/mcp-session-model.ts';
import type { McpAppPreviewClient } from '../src/mcp/mcp-app-preview.tsx';
import {
  createMcpSessionController,
  type McpSessionControllerClient,
  type McpSessionControllerRoutes,
  type McpSessionControllerTransport,
} from '../src/mcp/mcp-session-controller.ts';
import {
  McpPage,
  createMcpPageActionTracker,
  createMcpPageActionSession,
  downloadCurrentMcpProtocolTrace,
  mcpConfigDownload,
  mcpAppPreviewSourceFor,
  mcpPageControllerReplacementState,
  mcpPageSessionControls,
  supportedMcpAppPreviewProfiles,
  type McpPageController,
} from '../src/mcp/mcp-page.tsx';
import * as mcpPage from '../src/mcp/mcp-page.tsx';
import { mcpProtocolTraceDownload } from '../src/mcp/mcp-protocol-trace.ts';

const traceBinding = Object.freeze({ epochId: 'epoch-trace', serverName: 'weather', target: 'portable' as const });
const traceConnection = Object.freeze({ capabilities: { tools: {} }, protocolVersion: '2025-06-18', server: { name: 'weather', version: '1.0.0' } });

const traceController = (connect: () => Promise<void> = async () => undefined) => createMcpSessionController({
  clientFactory: (): McpSessionControllerClient => ({
    close: async () => undefined,
    connect: async () => connect(),
    request: async () => undefined,
  }),
  routes: {
    catalog: async () => ({ prompts: [], resourceTemplates: [], resources: [], tools: [] }),
    config: async () => ({ launch: { args: [], command: 'node', env: {}, kind: 'stdio' }, origin: 'artifact' }),
    restart: async () => traceConnection,
    stream: async (_id, _after, signal) => new Response(new ReadableStream<Uint8Array>({
      start: (stream) => signal?.addEventListener('abort', () => stream.close(), { once: true }),
    }), { headers: { 'content-type': 'application/x-ndjson' } }),
    trace: async () => ({ entries: [] }),
  } satisfies McpSessionControllerRoutes,
  transportFactory: (): McpSessionControllerTransport => ({
    close: async () => undefined,
    send: async () => undefined,
    session: Object.freeze({ binding: traceBinding, connection: traceConnection, id: 'real-trace-session', timeoutMs: 5_000 }),
    start: async () => undefined,
  }),
});

const downloadedProtocolTrace = async (session: ReturnType<typeof traceController>) => {
  const downloads: { readonly blob: Blob; readonly filename: string }[] = [];
  downloadCurrentMcpProtocolTrace((download) => { downloads.push(download); }, {
    history: session.history,
    model: session.model,
  });
  const [download] = downloads;
  if (download === undefined) throw new Error('Expected a current protocol trace download.');
  return { filename: download.filename, trace: JSON.parse(await download.blob.text()) };
};

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
  it('filters frozen artifact server options to the target and chooses the first valid server', () => {
    const { mcpPageServerNameFor, mcpPageServerOptionsFor } = mcpPage as typeof mcpPage & {
      readonly mcpPageServerNameFor: (serverName: string, options: readonly { readonly name: string; readonly target: string }[], allOptions: readonly { readonly name: string; readonly target: string }[]) => string;
      readonly mcpPageServerOptionsFor: (options: readonly { readonly name: string; readonly target: string }[], target: string) => readonly { readonly name: string; readonly target: string }[];
    };
    const allOptions = [
      { name: 'status', target: 'portable' },
      { name: 'build', target: 'portable' },
      { name: 'codex-only', target: 'codex' },
    ] as const;

    expect(mcpPageServerOptionsFor).toBeTypeOf('function');
    expect(mcpPageServerNameFor).toBeTypeOf('function');
    const options = mcpPageServerOptionsFor(allOptions, 'portable');
    expect(options).toEqual([
      { name: 'status', target: 'portable' },
      { name: 'build', target: 'portable' },
    ]);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options[0]!)).toBe(true);
    expect(mcpPageServerNameFor('', options, allOptions)).toBe('status');
    expect(mcpPageServerNameFor('codex-only', options, allOptions)).toBe('status');
    expect(mcpPageServerNameFor('manually-entered', options, allOptions)).toBe('manually-entered');
  });

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
    expect(markup).toContain('Download current protocol trace');
    expect(markup).toContain('current browser MCP trace, not a durable Playground session export');
    expect(markup).toContain('Download Inspector config');
    expect(markup).toContain('Trace delivery is delayed.');
  });

  it('builds a detached export of the complete current protocol trace without launch credentials', async () => {
    const mutableHistory = [{
      binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
      id: 'tool-1',
      operation: 'callTool',
      request: { arguments: { city: 'Berlin' }, name: 'weather' },
      result: { content: [{ text: 'Sunny', type: 'text' }] },
      timing: { completedAt: 1_700_000_000_020, durationMs: 10, startedAt: 1_700_000_000_010 },
    }];
    const mutableModel = {
      ...model,
      config: {
        launch: { args: ['private-server.mjs'], command: 'node', env: { API_TOKEN: 'foreground-secret' }, kind: 'stdio' },
        origin: 'artifact',
      },
      sessionId: 'opaque-session-1',
      sessionToken: 'browser-session-token',
      timeline: {
        droppedThroughSequence: 2,
        entries: [
          { earliestAvailableSequence: 3, latestDroppedSequence: 2, requestedAfterSequence: 0, type: 'replay.gap' },
          { direction: 'server', kind: 'frame', message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, occurredAt: 1_700_000_000_003, sequence: 3 },
          { invocation: mutableHistory[0], type: 'invocation' },
          { direction: 'client', kind: 'frame', message: { id: 2, jsonrpc: '2.0', method: 'tools/call', params: { arguments: { city: 'Berlin' }, name: 'weather' } }, occurredAt: 1_700_000_000_004, sequence: 4 },
        ],
        lastSequence: 4,
      },
    } as unknown as McpBrowserSessionModel;

    const download = mcpProtocolTraceDownload({
      history: mutableHistory as unknown as readonly McpBrowserSessionInvocation[],
      model: mutableModel,
    });
    mutableHistory[0]!.request.arguments.city = 'Mutated';
    (mutableModel.timeline.entries[3] as { message: { params: { arguments: { city: string } } } }).message.params.arguments.city = 'Mutated';
    const trace = JSON.parse(await download.blob.text());

    expect(download.filename).toBe('mcp-opaque-session-1-protocol-trace.json');
    expect(download.blob.type).toBe('application/json');
    expect(await download.blob.text()).toMatch(/\n$/u);
    expect(trace).toEqual({
      history: [{
        binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
        id: 'tool-1',
        operation: 'callTool',
        request: { arguments: { city: 'Berlin' }, name: 'weather' },
        result: { content: [{ text: 'Sunny', type: 'text' }] },
        timing: { completedAt: 1_700_000_000_020, durationMs: 10, startedAt: 1_700_000_000_010 },
      }],
      kind: 'agent-bundle.mcp-protocol-trace',
      session: {
        binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
        connection: { protocolVersion: '2025-06-18', serverCapabilities: { tools: {} }, serverInfo: { name: 'Weather Server' } },
        id: 'opaque-session-1',
        phase: 'idle',
      },
      timeline: {
        droppedThroughSequence: 2,
        entries: [
          { earliestAvailableSequence: 3, latestDroppedSequence: 2, requestedAfterSequence: 0, type: 'replay.gap' },
          { direction: 'server', kind: 'frame', message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, occurredAt: 1_700_000_000_003, sequence: 3 },
          { invocation: {
            binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
            id: 'tool-1',
            operation: 'callTool',
            request: { arguments: { city: 'Berlin' }, name: 'weather' },
            result: { content: [{ text: 'Sunny', type: 'text' }] },
            timing: { completedAt: 1_700_000_000_020, durationMs: 10, startedAt: 1_700_000_000_010 },
          }, type: 'invocation' },
          { direction: 'client', kind: 'frame', message: { id: 2, jsonrpc: '2.0', method: 'tools/call', params: { arguments: { city: 'Berlin' }, name: 'weather' } }, occurredAt: 1_700_000_000_004, sequence: 4 },
        ],
        lastSequence: 4,
      },
    });
    expect(JSON.stringify(trace)).not.toContain('private-server.mjs');
    expect(JSON.stringify(trace)).not.toContain('foreground-secret');
    expect(JSON.stringify(trace)).not.toContain('browser-session-token');
  });

  it('uses explicit null session facts and an idle filename when no session is present', async () => {
    const download = mcpProtocolTraceDownload({
      history: [],
      model: { ...model, binding: undefined, connection: undefined, sessionId: '' },
    });

    expect(download.filename).toBe('mcp-idle-protocol-trace.json');
    await expect(download.blob.text()).resolves.toContain('"binding": null');
    await expect(download.blob.text()).resolves.toContain('"connection": null');
    await expect(download.blob.text()).resolves.toContain('"id": null');
  });

  it('exports an unnegotiated fresh controller through the download callback without a fabricated session identity', async () => {
    const fresh = traceController();
    const download = await downloadedProtocolTrace(fresh);

    expect(download.filename).toBe('mcp-idle-protocol-trace.json');
    expect(download.trace.session).toEqual({ binding: null, connection: null, id: null, phase: 'idle' });
  });

  it('returns to an identity-less idle export after replacing a real controller on reset', async () => {
    const active = traceController();
    await active.open(traceBinding);
    const activeDownload = await downloadedProtocolTrace(active);
    await active.close();
    const resetDownload = await downloadedProtocolTrace(traceController());

    expect(activeDownload.filename).toBe('mcp-real-trace-session-protocol-trace.json');
    expect(activeDownload.trace.session).toMatchObject({ binding: traceBinding, id: 'real-trace-session' });
    expect(resetDownload.filename).toBe('mcp-idle-protocol-trace.json');
    expect(resetDownload.trace.session).toEqual({ binding: null, connection: null, id: null, phase: 'idle' });
  });

  it('keeps a connect failure before session negotiation identity-less in its download callback', async () => {
    const failed = traceController(async () => { throw new Error('connection refused'); });
    await expect(failed.open(traceBinding)).rejects.toThrow('connection refused');
    const download = await downloadedProtocolTrace(failed);

    expect(download.filename).toBe('mcp-idle-protocol-trace.json');
    expect(download.trace.session).toEqual({ binding: null, connection: null, id: null, phase: 'error' });
  });

  it('passes the canonical full trace through the supplied download sink', async () => {
    const downloads: Blob[] = [];

    downloadCurrentMcpProtocolTrace((download) => { downloads.push(download.blob); }, {
      history: controller().history,
      model,
    });

    expect(downloads).toHaveLength(1);
    await expect(downloads[0]!.text()).resolves.toContain('"kind": "agent-bundle.mcp-protocol-trace"');
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
