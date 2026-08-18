import { readFile } from 'node:fs/promises';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, rs } from '@rstest/core';

import type { McpBrowserSessionModel } from '../src/mcp/mcp-session-model.ts';
import type { DevRuntimeDiagnostic, DevRuntimeTraceSpan } from '../../agent-bundle/src/dev/runtime-protocol.ts';
import {
  inspectorLogEntries,
  inspectorProtocolEntries,
  inspectorSessionBindingKey,
  inspectorSessionTabs,
} from '../src/inspector/adapter/inspector-session-adapter-model.ts';
import {
  InspectorSessionAdapter,
  InspectorRuntimeEvidence,
  agentBundleInspectorTheme,
} from '../src/inspector/adapter/inspector-session-adapter.tsx';

const screens = rs.hoisted(() => ({
  logging: undefined as undefined | Record<string, unknown>,
  prompts: undefined as undefined | Record<string, unknown>,
  protocol: undefined as undefined | Record<string, unknown>,
  resources: undefined as undefined | Record<string, unknown>,
  tools: undefined as undefined | Record<string, unknown>,
}));

rs.mock('../src/inspector/adapter/inspector-session-adapter-vendor.js', () => ({
  ALL_LEVELS_VISIBLE: { alert: true, critical: true, debug: true, emergency: true, error: true, info: true, notice: true, warning: true },
  clearScrollMemory: () => undefined,
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
      {
        direction: 'server',
        kind: 'frame',
        message: { id: 2, jsonrpc: '2.0', result: { content: [] } },
        occurredAt: 1_700_000_000_006,
        sequence: 12,
      },
    ],
    lastSequence: 12,
  },
} as unknown as McpBrowserSessionModel;

describe('Inspector session adapter', () => {
  it('renders immutable runtime evidence in provider order without a controller action', () => {
    const trace = [
      { id: 'render', phase: 'rsc-render', startedAt: '2026-08-15T12:00:00.000Z', status: 'succeeded' },
      { id: 'lowering', parentId: 'render', phase: 'lowering-contract', startedAt: '2026-08-15T12:00:01.000Z', status: 'succeeded' },
    ] satisfies readonly DevRuntimeTraceSpan[];
    const diagnostics = [{ code: 'RSC001', message: 'Runtime is ready.', phase: 'provider-lifecycle', severity: 'info' }] satisfies readonly DevRuntimeDiagnostic[];
    const markup = renderToStaticMarkup(createElement(InspectorRuntimeEvidence, {
      evidence: { kind: 'trace', trace },
    }));
    const diagnosticMarkup = renderToStaticMarkup(createElement(InspectorRuntimeEvidence, {
      evidence: { diagnostics, kind: 'diagnostics' },
    }));
    const protocolMarkup = renderToStaticMarkup(createElement(InspectorRuntimeEvidence, {
      evidence: { kind: 'protocol', protocol: { jsonrpc: '2.0', method: 'tools/call' }, trace },
    }));

    expect(markup).toContain('Render trace');
    expect(markup.indexOf('rsc-render')).toBeLessThan(markup.indexOf('lowering-contract'));
    expect(diagnosticMarkup).toContain('provider-lifecycle');
    expect(diagnosticMarkup).toContain('Runtime is ready.');
    expect(protocolMarkup).toContain('tools/call');
    expect(`${markup}${diagnosticMarkup}${protocolMarkup}`).not.toContain('Open MCP session');
    expect(`${markup}${diagnosticMarkup}${protocolMarkup}`).not.toContain('Set Active Level');
    expect(`${markup}${diagnosticMarkup}${protocolMarkup}`).not.toContain('Replay');
  });

  it('presents the immutable raw trace with its original sequence and timestamp', () => {
    const entries = inspectorProtocolEntries(model.timeline.entries);
    const logs = inspectorLogEntries(model.timeline.entries);

    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({ direction: 'request', id: 'trace-7', sequence: 7 });
    expect(entries[0]!.timestamp.getTime()).toBe(1_700_000_000_001);
    expect(entries[1]).toMatchObject({ direction: 'response', id: 'trace-8', sequence: 8 });
    expect(entries[2]).toMatchObject({ direction: 'notification', id: 'trace-9', origin: 'server', sequence: 9 });
    expect(entries[3]).toMatchObject({ direction: 'request', id: 'trace-11', sequence: 11 });
    expect(entries[3]!.message).toEqual({ id: 2, jsonrpc: '2.0', method: 'tools/call' });
    expect(entries[4]).toMatchObject({ direction: 'response', id: 'trace-12', sequence: 12 });
    expect(entries[4]!.message).toEqual({ id: 2, jsonrpc: '2.0', result: { content: [] } });
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

  it('uses runtime session revision rather than implementation vectors as the Inspector scroll-memory boundary', () => {
    const binding = {
      kind: 'runtime' as const,
      binding: {
        definitionDigest: 'definition-a', registryRevision: 7, serverDigest: 'server-a', serverName: 'weather', sessionId: 'runtime-session-a', sessionRevision: 3, target: 'portable', transportDigest: 'transport-a',
      },
    };
    expect(inspectorSessionBindingKey(binding)).toBe('runtime\u0000runtime-session-a\u00003\u0000portable\u0000weather');
    expect(inspectorSessionBindingKey({ ...binding, binding: { ...binding.binding, sessionRevision: 4 } })).not.toBe(
      inspectorSessionBindingKey(binding),
    );
    expect(inspectorSessionBindingKey({ ...binding, binding: {
      ...binding.binding,
      definitionDigest: 'definition-b',
      serverDigest: 'server-b',
      transportDigest: 'transport-b',
    } })).toBe(inspectorSessionBindingKey(binding));
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
    for (const label of ['Tools', 'Resources', 'Prompts', 'Protocol', 'Logging']) expect(markup).toContain(`>${label}<`);
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
    expect(screens.protocol!.entries).toHaveLength(5);
    expect(screens.protocol!.onClearSection).toBeTypeOf('function');
    expect(screens.protocol!.onExportSection).toBeTypeOf('function');
    expect(screens.protocol!.onReplay).toBeTypeOf('function');
    (screens.protocol!.onReplay as (id: string) => void)('trace-7');
    expect(controller.invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: 'callTool',
      request: { arguments: { city: 'Berlin' }, name: 'weather' },
    }));
    expect(screens.logging!.embedded).toBe(true);
    expect(markup).not.toContain('Set Active Level');
  });

  it('disables unrouted prompts and strips unavailable templates without installing prompt callbacks', async () => {
    screens.prompts = undefined;
    screens.resources = undefined;
    const controller = {
      cancel: rs.fn(),
      invoke: rs.fn(async () => ({ content: [] })),
    };
    const unavailable = {
      prompts: 'not-routed' as const,
      resourceTemplates: 'not-routed' as const,
      resources: 'available' as const,
      tools: 'available' as const,
    };
    const promptMarkup = renderToStaticMarkup(createElement(InspectorSessionAdapter, {
      availability: unavailable,
      controller,
      initialTab: 'prompts',
      model,
    } as never));

    expect(promptMarkup).toContain('Prompts are unavailable for this runtime session.');
    expect(promptMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Prompts<\/button>/u);
    expect(promptMarkup).toContain('tools-screen');
    expect(screens.prompts).toBeUndefined();
    expect(controller.invoke).not.toHaveBeenCalled();

    const resourceMarkup = renderToStaticMarkup(createElement(InspectorSessionAdapter, {
      availability: unavailable,
      controller,
      initialTab: 'resources',
      model,
    } as never));
    expect(resourceMarkup).toContain('Resource templates are unavailable for this runtime session.');
    expect(screens.resources!.templates).toEqual([]);

    const onReadResource = screens.resources!.onReadResource as (uri: string) => void;
    onReadResource('weather://berlin');
    await Promise.resolve();
    expect(controller.invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: 'readResource',
      request: { uri: 'weather://berlin' },
    }));
    controller.invoke.mockClear();
    (screens.resources!.onRefreshList as () => void)();
    await Promise.resolve();
    expect(controller.invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: 'listResources',
      request: {},
    }));
  });

  it('keeps artifact prompt callbacks routed by default', async () => {
    screens.prompts = undefined;
    const controller = { cancel: rs.fn(), invoke: rs.fn(async () => ({ messages: [] })) };
    renderToStaticMarkup(createElement(InspectorSessionAdapter, { controller, initialTab: 'prompts', model }));

    expect(screens.prompts).toBeDefined();
    const onGetPrompt = screens.prompts!.onGetPrompt as (name: string, args: Record<string, string>) => void;
    onGetPrompt('greet', { name: 'Ada' });
    await Promise.resolve();
    expect(controller.invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: 'getPrompt',
      request: { arguments: { name: 'Ada' }, name: 'greet' },
    }));
  });

  it('exports a frozen timeline and retains local replay and log-level diagnostics without controller calls', () => {
    screens.protocol = undefined;
    screens.logging = undefined;
    const controller = { cancel: rs.fn(), invoke: rs.fn(async () => ({ content: [] })) };
    const exports: readonly unknown[][] = [];
    renderToStaticMarkup(createElement(InspectorSessionAdapter, {
      controller,
      initialTab: 'protocol',
      model,
      onExportTrace: (entries) => { (exports as unknown[][]).push(entries as unknown[]); },
    }));
    (screens.protocol!.onExport as () => void)();
    (screens.protocol!.onReplay as (id: string) => void)('trace-7');

    renderToStaticMarkup(createElement(InspectorSessionAdapter, { controller, initialTab: 'logging', model }));
    (screens.logging!.onSetLevel as (level: string) => void)('debug');

    expect(exports).toHaveLength(1);
    expect(Object.isFrozen(exports[0]!)).toBe(true);
    expect(controller.invoke).not.toHaveBeenCalled();
  });

  it('pins the complete effect-owned revision reset set', async () => {
    const source = await readFile('packages/workbench/src/inspector/adapter/inspector-session-adapter.tsx', 'utf8');
    const resetEffect = source.slice(source.indexOf('useLayoutEffect(() =>'), source.indexOf('  const protocolEntries'));

    expect(resetEffect).toContain('lastResetBindingKey.current = bindingKey');
    expect(resetEffect).not.toContain('previousBindingKey.current');
    expect(resetEffect).not.toContain('actionGeneration.current');
    for (const resetter of [
      'clearScrollMemory()',
      'setTab(availableTab(initialTab, availability))',
      'setToolsUi(initialToolsUi)',
      'setResourcesUi(initialResourcesUi)',
      'setPromptsUi(initialPromptsUi)',
      'setProtocolUi(initialProtocolUi)',
      'setLogsUi(initialLogsUi)',
      'setToolCall(undefined)',
      'setToolRequestId(undefined)',
      'setReadResource(undefined)',
      'setGetPrompt(undefined)',
      'setPinnedIds(new Set())',
      'setProtocolCleared(false)',
      'setLoggingCleared(false)',
      "setLoggingDiagnostic('Log-level changes are unavailable because this W13 session does not expose logging/setLevel.')",
      "setSortDirection('oldest-first')",
      'setCompact(false)',
      'setProtocolReplayUnavailable(false)',
    ]) expect(resetEffect).toContain(resetter);
  });

   it('sends the complete underlying timeline to Protocol and Logging export callbacks', () => {
    const controller = { cancel: rs.fn(), invoke: rs.fn(async () => ({ content: [] })) };
    const exports: (readonly unknown[])[] = [];
    const onExportTrace = (entries: readonly unknown[]): void => { exports.push(entries); };

    renderToStaticMarkup(createElement(InspectorSessionAdapter, { controller, initialTab: 'protocol', model, onExportTrace }));
    (screens.protocol!.onExport as () => void)();
    renderToStaticMarkup(createElement(InspectorSessionAdapter, { controller, initialTab: 'logging', model, onExportTrace }));
    (screens.logging!.onExport as () => void)();

    expect(exports).toEqual([model.timeline.entries, model.timeline.entries]);
   });
});
