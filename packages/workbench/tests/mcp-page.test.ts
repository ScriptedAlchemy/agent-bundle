import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import type { McpSessionInspectorConfig } from '../../agent-bundle/src/contracts/mcp-session.ts';
import {
  createMcpBrowserSessionModel,
  reduceMcpBrowserSession,
  type McpBrowserSessionInvocation,
  type McpBrowserSessionModel,
} from '../src/mcp/mcp-session-model.ts';
import type { McpAppPreviewClient, McpAppRuntimePreviewProps } from '../src/mcp/mcp-app-preview.tsx';
import type { McpInspectorLaunchModel } from '../src/mcp/mcp-inspector-launch-model.ts';
import {
  createMcpSessionController,
  type McpSessionControllerClient,
  type McpSessionControllerRoutes,
  type McpSessionControllerTransport,
} from '../src/mcp/mcp-session-controller.ts';
import {
  MCP_PAGE_TASK_TTL_MS,
  McpPage,
  McpProtocolEvidence,
  createMcpPageActionTracker,
  createMcpPageActionSession,
  mcpAppConsentDetailsSummary,
  downloadCurrentMcpProtocolTrace,
  mcpConfigDownload,
  isTerminalMcpTask,
  mcpAppPreviewSourceFor,
  mcpPageControllerReplacementState,
  mcpPageTasksFor,
  mcpPageSessionControls,
  supportedMcpAppPreviewProfiles,
  type McpPageArtifactProps,
  type McpPageController,
  type McpPageInspectorLaunch,
  type McpPageRuntimeProps,
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

const runtimeBinding = Object.freeze({
  definitionDigest: 'definition-runtime-weather',
  registryRevision: 4,
  serverDigest: 'server-runtime-weather',
  serverName: 'runtime-weather',
  sessionId: 'runtime-session-weather',
  sessionRevision: 2,
  target: 'portable',
  transportDigest: 'transport-runtime-weather',
});

const runtimePreview = Object.freeze({
  client: appPreviewClient,
  createBridgeFactory: (() => {
    throw new Error('Runtime preview must not construct a bridge during static page rendering.');
  }) as McpAppRuntimePreviewProps['createBridgeFactory'],
  kind: 'runtime' as const,
  profile: Object.freeze({
    claimsRealHostParity: false,
    evidence: 'simulated' as const,
    id: 'portable',
    label: 'Portable MCP Apps',
    version: 'agent-bundle:mcp-apps:2026-01-26',
  }),
  profileId: 'portable',
  run: Object.freeze({
    completedAt: '2026-08-16T00:00:01.000Z',
    id: 'runtime-run-weather',
    input: Object.freeze({ city: 'Paris' }),
    result: Object.freeze({
      app: Object.freeze({ mcpBinding: runtimeBinding, resourceUri: 'ui://weather/runtime.html', surfaceId: 'mcp.edit-weather' }),
      modelVisible: Object.freeze({ temperature: 22 }),
      state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'private-state', stateVersion: 1 }) }),
      trace: Object.freeze([]),
      tree: Object.freeze([]),
    }),
    startedAt: '2026-08-16T00:00:00.000Z',
    status: 'succeeded' as const,
    surfaceId: 'mcp.render-weather',
    target: 'portable',
    vector: Object.freeze({ providerSessionId: 'private-provider', runtimeGenerationId: 'runtime-generation-weather', sourceRevision: 'runtime-source-weather', stateStoreId: 'private-state', stateVersion: 1 }),
  }),
  surface: Object.freeze({ fixtures: Object.freeze([]), id: 'mcp.render-weather', kind: 'mcp-app' as const, label: 'Runtime weather', readOnly: false, targets: Object.freeze(['portable']) }),
}) as unknown as McpAppRuntimePreviewProps;

const runtimePreviewForBinding = (binding: unknown): McpAppRuntimePreviewProps => Object.freeze({
  ...runtimePreview,
  run: Object.freeze({
    ...runtimePreview.run,
    result: Object.freeze({
      ...runtimePreview.run.result!,
      app: Object.freeze({ ...runtimePreview.run.result!.app!, mcpBinding: binding }),
    }),
  }),
}) as unknown as McpAppRuntimePreviewProps;

const runtimeMarkup = (sourceBinding: unknown, selectionBinding: unknown, preview = runtimePreview, selectionKind: 'artifact' | 'runtime' = 'runtime'): string => renderToStaticMarkup(createElement(McpPage, {
  controller: controller(),
  initialPreview: selectionKind === 'runtime'
    ? { binding: selectionBinding, kind: 'runtime', preview }
    : { kind: 'artifact', source: { input: {}, invocationId: 'artifact', result: {}, sessionId: 'artifact-session', toolName: 'artifact-tool' } },
  runtimePreviewDependencies: { client: runtimePreview.client, createBridgeFactory: runtimePreview.createBridgeFactory },
  source: { binding: sourceBinding, kind: 'runtime' },
} as unknown as McpPageRuntimeProps));

const reducedModelForConfig = (config: McpSessionInspectorConfig): McpBrowserSessionModel => {
  const opening = reduceMcpBrowserSession(createMcpBrowserSessionModel('sanitized-session'), {
    binding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
    type: 'open',
  });
  const configured = reduceMcpBrowserSession(opening, { config, type: 'config' });
  return reduceMcpBrowserSession(configured, { type: 'ready' });
};

describe('MCP page', () => {
  it('describes distinct consent targets with bounded redacted React text', () => {
    const call = mcpAppConsentDetailsSummary({
      actionFingerprint: 'act-tool-demo123',
      capability: 'call-tool',
      details: { arguments: { api_key: 'do-not-show', message: '<img src=x onerror=alert(1)>' }, name: 'weather.lookup' },
    });
    const link = mcpAppConsentDetailsSummary({
      actionFingerprint: 'act-link-demo123',
      capability: 'open-external-link',
      details: { url: 'https://example.test/billing?token=do-not-show#fragment' },
    });
    const credentialedLink = mcpAppConsentDetailsSummary({
      capability: 'open-external-link',
      details: { url: 'https://user:do-not-show@example.test/private' },
    });
    const download = mcpAppConsentDetailsSummary({
      actionFingerprint: 'act-file-demo123',
      capability: 'download-file',
      details: { contents: [{ text: 'do-not-show', type: 'text' }, { text: 'also-private', type: 'text' }] },
    });
    const markup = renderToStaticMarkup(createElement('p', undefined, call));

    expect(call).toContain('Tool: weather.lookup');
    expect(call).toContain('"api_key": "[redacted]"');
    expect(call).not.toContain('do-not-show');
    expect(call).toContain('action reference: act-tool-demo123');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img src=x');
    expect(link).toBe('External link: https://example.test/billing; query keys: [redacted]; action reference: act-link-demo123');
    expect(link).not.toContain('token=');
    expect(credentialedLink).toBe('External link target unavailable.');
    expect(download).toBe('Download 2 files (1: text 11 B, 2: text 12 B).; action reference: act-file-demo123');
    expect(download).not.toContain('also-private');
    expect(mcpAppConsentDetailsSummary({ capability: 'call-tool', details: { arguments: { note: 'a'.repeat(2_000) }, name: 'long' } }).length).toBeLessThanOrEqual(480);
  });

  it('renders distinct bounded references for concurrent same-capability links and downloads', () => {
    const linkA = mcpAppConsentDetailsSummary({
      actionFingerprint: 'act-link-alpha12',
      capability: 'open-external-link',
      details: { url: 'https://example.test/export?account=first&token=do-not-show-a' },
    });
    const linkB = mcpAppConsentDetailsSummary({
      actionFingerprint: 'act-link-bravo12',
      capability: 'open-external-link',
      details: { url: 'https://example.test/export?report=second&token=do-not-show-b' },
    });
    const downloadA = mcpAppConsentDetailsSummary({
      actionFingerprint: 'act-file-alpha12',
      capability: 'download-file',
      details: { contents: [{ text: 'one', type: 'text' }] },
    });
    const downloadB = mcpAppConsentDetailsSummary({
      actionFingerprint: 'act-file-bravo12',
      capability: 'download-file',
      details: { contents: [{ text: 'two-two', type: 'text' }] },
    });
    const markup = renderToStaticMarkup(createElement('ol', undefined, [linkA, linkB, downloadA, downloadB].map((label) => createElement('li', { key: label }, label))));

    expect(new Set([linkA, linkB, downloadA, downloadB]).size).toBe(4);
    expect(linkA).toContain('query keys: [redacted], account');
    expect(linkB).toContain('query keys: [redacted], report');
    expect(downloadA).toContain('1: text 3 B');
    expect(downloadB).toContain('1: text 7 B');
    expect(markup).toContain('act-link-alpha12');
    expect(markup).not.toContain('do-not-show');
    expect(markup).not.toContain('grant-');
    expect(markup).not.toContain('authorizationId');
  });

  it('renders provider protocol evidence without adding live session controls', () => {
    const markup = renderToStaticMarkup(createElement(McpProtocolEvidence, {
      ariaLabel: 'Provider MCP protocol evidence',
      protocol: { jsonrpc: '2.0', method: 'tools/call' },
      trace: [
        { id: 'render', phase: 'mcp-protocol', status: 'succeeded' },
        { id: 'resource', parentId: 'render', phase: 'resource-selection', status: 'succeeded' },
      ],
    }));

    expect(markup).toContain('aria-label="Provider MCP protocol evidence"');
    expect(markup).toContain('tools/call');
    expect(markup.indexOf('mcp-protocol')).toBeLessThan(markup.indexOf('resource-selection'));
    expect(markup).not.toContain('Open MCP session');
    expect(markup).not.toContain('Restart MCP session');
    expect(markup).not.toContain('Close MCP session');
    expect(markup).not.toContain('Replay');
  });

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

  it('rebinds an idle catalog selection to the current epoch without treating an unresolved catalog as manual input', () => {
    const { mcpPageBindingFor } = mcpPage as typeof mcpPage & {
      readonly mcpPageBindingFor: (binding: {
        readonly epochId: string;
        readonly serverName: string;
        readonly serverNameOrigin: 'catalog' | 'manual';
        readonly target: string;
      }, options: {
        readonly epochId: string;
        readonly serverCatalogState: 'loading' | 'ready';
        readonly serverOptions: readonly { readonly name: string; readonly target: string }[];
        readonly sessionPhase: 'idle' | 'opening' | 'ready';
        readonly targetOptions: readonly string[];
      }) => {
        readonly epochId: string;
        readonly serverName: string;
        readonly serverNameOrigin: 'catalog' | 'manual';
        readonly target: string;
      };
    };
    const catalogA = { epochId: 'epoch-A', serverName: 'status', serverNameOrigin: 'catalog' as const, target: 'portable' as const };
    const loadingB = mcpPageBindingFor(catalogA, {
      epochId: 'epoch-B', serverCatalogState: 'loading', serverOptions: [], sessionPhase: 'idle', targetOptions: ['codex', 'portable'],
    });

    expect(loadingB).toEqual({ epochId: 'epoch-B', serverName: 'status', serverNameOrigin: 'catalog', target: 'codex' });
    expect(mcpPageBindingFor(loadingB, {
      epochId: 'epoch-B',
      serverCatalogState: 'ready',
      serverOptions: [{ name: 'build', target: 'codex' }],
      sessionPhase: 'idle',
      targetOptions: ['codex', 'portable'],
    })).toEqual({ epochId: 'epoch-B', serverName: 'build', serverNameOrigin: 'catalog', target: 'codex' });
    expect(mcpPageBindingFor(loadingB, {
      epochId: 'epoch-B',
      serverCatalogState: 'ready',
      serverOptions: [],
      sessionPhase: 'idle',
      targetOptions: ['codex', 'portable'],
    })).toEqual({ epochId: 'epoch-B', serverName: '', serverNameOrigin: 'catalog', target: 'codex' });
    expect(mcpPageBindingFor({ ...catalogA, serverName: 'operator-server', serverNameOrigin: 'manual' }, {
      epochId: 'epoch-B',
      serverCatalogState: 'ready',
      serverOptions: [{ name: 'build', target: 'codex' }],
      sessionPhase: 'idle',
      targetOptions: ['codex', 'portable'],
    })).toEqual({ epochId: 'epoch-B', serverName: 'operator-server', serverNameOrigin: 'manual', target: 'codex' });
    expect(mcpPageBindingFor({ ...catalogA, serverName: 'operator-server', serverNameOrigin: 'manual' }, {
      epochId: 'epoch-B',
      serverCatalogState: 'ready',
      serverOptions: [],
      sessionPhase: 'idle',
      targetOptions: ['codex', 'portable'],
    })).toEqual({ epochId: 'epoch-B', serverName: 'operator-server', serverNameOrigin: 'manual', target: 'codex' });
    expect(mcpPageBindingFor(catalogA, {
      epochId: 'epoch-B',
      serverCatalogState: 'ready',
      serverOptions: [{ name: 'build', target: 'codex' }],
      sessionPhase: 'ready',
      targetOptions: ['codex', 'portable'],
    })).toEqual(catalogA);
  });

  it('blocks an A(status) to B loading rebinding from becoming an open session', () => {
    const { mcpPageOpenBindingFor } = mcpPage as typeof mcpPage & {
      readonly mcpPageOpenBindingFor: (binding: {
        readonly epochId: string;
        readonly serverName: string;
        readonly serverNameOrigin: 'catalog' | 'manual';
        readonly target: string;
      }, options: {
        readonly epochId: string;
        readonly serverCatalogState: 'loading' | 'ready';
        readonly serverOptions: readonly { readonly name: string; readonly target: string }[];
        readonly sessionPhase: 'idle' | 'opening' | 'ready';
        readonly targetOptions: readonly string[];
      }) => { readonly epochId: string; readonly serverName: string; readonly target: string } | undefined;
    };
    const loadingB = { epochId: 'epoch-B', serverName: 'status', serverNameOrigin: 'catalog' as const, target: 'codex' };
    const loadingOptions = {
      epochId: 'epoch-B', serverCatalogState: 'loading' as const, serverOptions: [], sessionPhase: 'idle' as const, targetOptions: ['codex', 'portable'],
    };

    expect(mcpPageSessionControls('idle', [], false, 'loading')).toMatchObject({ open: false });
    expect(mcpPageOpenBindingFor(loadingB, loadingOptions)).toBeUndefined();
    expect(mcpPageOpenBindingFor(loadingB, {
      ...loadingOptions,
      serverCatalogState: 'ready',
      serverOptions: [{ name: 'build', target: 'codex' }],
    })).toBeUndefined();
  });

  it('renders Open MCP session disabled while its artifact server catalog is loading', () => {
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: controller(),
      epochOptions: ['epoch-B'],
      initialBinding: { epochId: 'epoch-B', serverName: 'status', target: 'codex' },
      serverCatalogState: 'loading',
      serverOptions: [],
      targetOptions: ['codex', 'portable'],
    }));

    expect(markup).toContain('<button disabled="" type="submit">Open MCP session</button>');
  });

  it('accepts a Routes-page tool prefill without executing the call', () => {
    const pageController = controller();
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: pageController,
      epochOptions: ['epoch-1'],
      initialBinding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
      initialToolPrefill: {
        arguments: { city: 'Berlin' },
        serverName: 'weather',
        toolName: 'weather',
      },
      serverOptions: [{ name: 'weather', target: 'codex' }],
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('Tool call prefilled from Routes');
    expect(markup).toContain('weather');
    expect(markup).toContain('Berlin');
    expect(markup).toContain('Call weather');
    expect(markup).not.toContain('no longer advertises');
    expect(pageController.history).toHaveLength(1);
  });

  it('rejects a stale Routes-page tool prefill without selecting another tool', () => {
    const pageController = controller();
    const readyPageController: McpPageController = {
      ...pageController,
      model: { ...model, phase: 'ready' } as McpBrowserSessionModel,
    };
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: readyPageController,
      epochOptions: ['epoch-1'],
      initialBinding: { epochId: 'epoch-1', serverName: 'weather', target: 'codex' },
      initialToolPrefill: {
        arguments: { city: 'Berlin' },
        serverName: 'weather',
        toolName: 'retired_weather',
      },
      serverOptions: [{ name: 'weather', target: 'codex' }],
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('The server no longer advertises the &quot;retired_weather&quot; tool.');
    expect(markup).not.toContain('id="mcp-tool-arguments"');
    expect(markup).not.toContain('Call weather');
    expect(markup).not.toContain('Call clock');
    expect(pageController.history).toHaveLength(1);
  });

  it('settles a current inspection rejection to ready-empty while ignoring stale or aborted failures', () => {
    const { mcpPageEmptyServerCatalogFor, mcpPageServerCatalogFor } = mcpPage as typeof mcpPage & {
      readonly mcpPageEmptyServerCatalogFor: (epochId: string, signal: Pick<AbortSignal, 'aborted'>) => unknown;
      readonly mcpPageServerCatalogFor: (epochId: string, inspection: {
        readonly epochId: string;
        readonly runtime: { readonly mcpServers: readonly { readonly name: string; readonly target: string }[] };
      }, signal: Pick<AbortSignal, 'aborted'>) => unknown;
    };
    const cancelled = new AbortController();
    cancelled.abort();

    expect(mcpPageServerCatalogFor('epoch-A', {
      epochId: 'epoch-A', runtime: { mcpServers: [{ name: 'status', target: 'portable' }] },
    }, cancelled.signal)).toBeUndefined();
    expect(mcpPageServerCatalogFor('epoch-B', {
      epochId: 'epoch-A', runtime: { mcpServers: [{ name: 'status', target: 'portable' }] },
    }, new AbortController().signal)).toBeUndefined();
    expect(mcpPageServerCatalogFor('epoch-B', {
      epochId: 'epoch-B', runtime: { mcpServers: [{ name: 'build', target: 'portable' }] },
    }, new AbortController().signal)).toEqual({
      epochId: 'epoch-B', options: [{ name: 'build', target: 'portable' }],
    });
    expect(mcpPageEmptyServerCatalogFor('epoch-B', new AbortController().signal)).toEqual({
      epochId: 'epoch-B', options: [],
    });
    expect(mcpPageEmptyServerCatalogFor('epoch-B', cancelled.signal)).toBeUndefined();
    const staleFailure = new AbortController();
    staleFailure.abort();
    expect(mcpPageEmptyServerCatalogFor('epoch-A', staleFailure.signal)).toBeUndefined();
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
    expect(markup).toContain('placeholder="Server default"');
    expect(markup).not.toContain('value="5000"');
  });

  it('renders an initial runtime selection with immutable binding evidence and no artifact-open controls', () => {
    const opens: unknown[] = [];
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: { ...controller(), open: async (...input) => { opens.push(input); return model; } },
      initialPreview: { binding: runtimeBinding, kind: 'runtime', preview: runtimePreview },
      runtimePreviewDependencies: { client: runtimePreview.client, createBridgeFactory: runtimePreview.createBridgeFactory },
      source: { binding: runtimeBinding, kind: 'runtime' },
    }));

    expect(markup).toContain('Runtime-bound MCP session');
    expect(markup).toContain('runtime-weather');
    expect(markup).toContain('definition-runtime-weather');
    expect(markup).toContain('transport-runtime-weather');
    expect(markup).toContain('runtime-session-weather');
    expect(markup).not.toContain('id="mcp-epoch"');
    expect(markup).not.toContain('Open MCP session');
    expect(markup.match(/class="mcp-page-app-preview"/gu)).toHaveLength(1);
    expect(opens).toEqual([]);
  });

  it('keeps artifact and runtime initial-preview prop arms disjoint at compile time', () => {
    const artifactProps: McpPageArtifactProps = {
      controller: controller(),
      epochOptions: [],
      // @ts-expect-error artifact Page props cannot select the runtime preview arm.
      initialPreview: { binding: runtimeBinding, kind: 'runtime', preview: runtimePreview },
      targetOptions: [],
    };
    const runtimeProps: McpPageRuntimeProps = {
      controller: controller(),
      // @ts-expect-error runtime Page props cannot select the artifact preview arm.
      initialPreview: { kind: 'artifact', source: { input: {}, invocationId: 'artifact', result: {}, sessionId: 'artifact-session', toolName: 'artifact-tool' } },
      runtimePreviewDependencies: { client: runtimePreview.client, createBridgeFactory: runtimePreview.createBridgeFactory },
      source: { binding: runtimeBinding, kind: 'runtime' },
    };

    expect(artifactProps.source).toBeUndefined();
    expect(runtimeProps.source.kind).toBe('runtime');
  });

  it('admits only matching source, selection, and run-App runtime binding evidence before rendering', () => {
    const changedSelection = Object.freeze({ ...runtimeBinding, sessionRevision: runtimeBinding.sessionRevision + 1 });
    const changedApp = Object.freeze({ ...runtimeBinding, transportDigest: 'changed-transport-digest' });

    for (const markup of [
      runtimeMarkup(runtimeBinding, changedSelection),
      runtimeMarkup(runtimeBinding, runtimeBinding, runtimePreviewForBinding(changedApp)),
      runtimeMarkup(runtimeBinding, runtimeBinding, Object.freeze({
        ...runtimePreview,
        run: Object.freeze({ ...runtimePreview.run, result: Object.freeze({ ...runtimePreview.run.result, app: undefined }) }),
      }) as unknown as McpAppRuntimePreviewProps),
      runtimeMarkup(runtimeBinding, runtimeBinding, Object.freeze({
        ...runtimePreview,
        run: Object.freeze({ ...runtimePreview.run, surfaceId: 'mcp.render-other-weather' }),
      }) as unknown as McpAppRuntimePreviewProps),
      runtimeMarkup(runtimeBinding, runtimeBinding, Object.freeze({
        ...runtimePreview,
        run: Object.freeze({
          ...runtimePreview.run,
          result: Object.freeze({
            ...runtimePreview.run.result,
            app: Object.freeze({ ...runtimePreview.run.result!.app!, surfaceId: 'mcp/invalid-weather' }),
          }),
        }),
      }) as unknown as McpAppRuntimePreviewProps),
    ]) {
      expect(markup).toContain('Runtime App preview is unavailable');
      expect(markup).not.toContain('class="mcp-page-app-preview"');
    }
  });

  it('rejects a wrong selection kind, null-prototype binding, and invalid stable leaves before rendering', () => {
    const nullPrototypeBinding = Object.assign(Object.create(null), runtimeBinding);

    for (const markup of [
      runtimeMarkup(runtimeBinding, runtimeBinding, runtimePreview, 'artifact'),
      runtimeMarkup(nullPrototypeBinding, nullPrototypeBinding, runtimePreviewForBinding(nullPrototypeBinding)),
      runtimeMarkup({ ...runtimeBinding, registryRevision: Number.NaN }, runtimeBinding),
      runtimeMarkup(runtimeBinding, { ...runtimeBinding, sessionRevision: -1 }),
      runtimeMarkup(runtimeBinding, { ...runtimeBinding, registryRevision: 0 }),
      runtimeMarkup(runtimeBinding, runtimeBinding, runtimePreviewForBinding({ ...runtimeBinding, target: '' })),
    ]) {
      expect(markup).toContain('Runtime App preview is unavailable');
      expect(markup).not.toContain('class="mcp-page-app-preview"');
    }
  });

  it('rejects extra, accessor, nonordinary, and trapped runtime binding evidence without invoking getters', () => {
    let getterReads = 0;
    const accessor = Object.create(Object.prototype, {
      ...Object.getOwnPropertyDescriptors(runtimeBinding),
      serverName: {
        configurable: true,
        enumerable: true,
        get: () => {
          getterReads += 1;
          return 'accessor-runtime-weather';
        },
      },
    });
    const inherited = Object.assign(Object.create({ inherited: true }), runtimeBinding);
    const trapped = new Proxy({ ...runtimeBinding }, { ownKeys: () => { throw new Error('binding ownKeys trap'); } });

    for (const binding of [
      Object.freeze({ ...runtimeBinding, unexpected: true }),
      Object.assign({ ...runtimeBinding }, { [Symbol('runtime-binding')]: true }),
      accessor,
      inherited,
      trapped,
    ]) {
      const markup = runtimeMarkup(binding, binding, runtimePreviewForBinding(binding));
      expect(markup).toContain('Runtime App preview is unavailable');
      expect(markup).not.toContain('class="mcp-page-app-preview"');
    }
    expect(getterReads).toBe(0);
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

  describe('task-augmented tool calls (#369)', () => {
    const at = (offset: number) => ({ completedAt: 1_700_000_000_010 + offset, durationMs: 5, startedAt: 1_700_000_000_005 + offset });
    const taskId = 'a3f0c2d1-0000-4000-8000-000000000369';
    const working = { createdAt: '2026-09-04T00:00:00.000Z', lastUpdatedAt: '2026-09-04T00:00:00.000Z', pollInterval: 250, status: 'working', taskId, ttl: 600_000 };
    const history: McpBrowserSessionInvocation[] = [
      { id: 'create', operation: 'callToolTask', request: { arguments: { holdMs: 400 }, name: 'wait', task: { ttl: 600_000 } }, result: { task: working }, timing: at(0) },
      {
        id: 'poll-1',
        operation: 'getTask',
        request: { taskId },
        result: { ...working, _meta: { 'agent-bundle/progress': { message: 'waiting', progress: 1, total: 4 } }, lastUpdatedAt: '2026-09-04T00:00:00.100Z', statusMessage: 'waiting' },
        timing: at(100),
      },
      { id: 'result', operation: 'getTaskResult', request: { taskId }, result: { content: [{ text: 'waited 400ms', type: 'text' }], structuredContent: { waitedMs: 400 } }, timing: at(400) },
      { id: 'poll-2', operation: 'getTask', request: { taskId }, result: { ...working, lastUpdatedAt: '2026-09-04T00:00:00.400Z', status: 'completed' }, timing: at(410) },
      { id: 'other', operation: 'callTool', request: { arguments: {}, name: 'echo' }, result: { content: [] }, timing: at(500) },
      { id: 'gone', operation: 'getTask', request: { taskId: 'expired' }, error: { code: -32_602, message: 'Task not found: expired' }, timing: at(600) },
    ];

    it('folds the invocation history into the session\'s tasks, newest answers winning', () => {
      const tasks = mcpPageTasksFor(history);

      expect(tasks).toEqual([{
        createdBy: 'create',
        progress: { message: 'waiting', progress: 1, total: 4 },
        result: { content: [{ text: 'waited 400ms', type: 'text' }], structuredContent: { waitedMs: 400 } },
        task: { ...working, lastUpdatedAt: '2026-09-04T00:00:00.400Z', status: 'completed' },
        toolName: 'wait',
      }]);
      expect(isTerminalMcpTask(tasks[0]!)).toBe(true);
      // Mid-flight: the latest tasks/get answer is the task, its progress meta lifted beside it.
      const midway = mcpPageTasksFor(history.slice(0, 2));
      expect(midway[0]).toMatchObject({ progress: { progress: 1, total: 4 }, task: { status: 'working', statusMessage: 'waiting' } });
      expect(isTerminalMcpTask(midway[0]!)).toBe(false);
      // A listed task the session did not create is still shown, without a tool name.
      const listed = mcpPageTasksFor([{ id: 'list', operation: 'listTasks', request: {}, result: { tasks: [{ ...working, taskId: 'listed-1' }] }, timing: at(0) }]);
      expect(listed).toEqual([{ progress: undefined, task: { ...working, taskId: 'listed-1' } }]);
      // An error answer on a known task is kept; one on an unknown task adds nothing.
      const failing = mcpPageTasksFor([history[0]!, { ...history[5]!, request: { taskId } }]);
      expect(failing[0]).toMatchObject({ error: { code: -32_602 }, task: { status: 'working' } });
      expect(mcpPageTasksFor([history[5]!])).toEqual([]);
      // A later successful answer — a poll or the result — clears the error, so polling resumes.
      const recovered = mcpPageTasksFor([history[0]!, { ...history[5]!, request: { taskId } }, history[1]!]);
      expect(recovered[0]).not.toHaveProperty('error');
      expect(recovered[0]).toMatchObject({ task: { status: 'working', statusMessage: 'waiting' } });
      const resultAfterTimeout = mcpPageTasksFor([history[0]!, { ...history[2]!, error: { message: 'timed out' }, result: undefined }, history[2]!]);
      expect(resultAfterTimeout[0]).not.toHaveProperty('error');
      expect(resultAfterTimeout[0]).toMatchObject({ result: { structuredContent: { waitedMs: 400 } } });
    });

    it('renders the task panel, the run-as-task toggle for opted-in tools, and the list control when the server declares tasks', () => {
      const taskModel = {
        ...model,
        catalogs: {
          ...model.catalogs,
          tools: [
            { description: 'Waits.', execution: { taskSupport: 'optional' }, inputSchema: { properties: {}, type: 'object' }, name: 'wait' },
            { description: 'Task only.', execution: { taskSupport: 'required' }, name: 'background' },
            { description: 'Ordinary.', name: 'echo' },
          ],
        },
        connection: { ...model.connection, serverCapabilities: { tasks: { cancel: {}, list: {}, requests: { tools: { call: {} } } }, tools: {} } },
        phase: 'ready',
      } as unknown as McpBrowserSessionModel;
      const markup = renderToStaticMarkup(createElement(McpPage, {
        controller: { ...controller(), history: history.slice(0, 2), model: taskModel },
        epochOptions: ['epoch-1'],
        targetOptions: ['codex'],
      }));

      expect(markup).toContain('Run as task');
      expect(markup).toContain('>List tasks</button>');
      expect(markup).toContain('aria-label="MCP tasks"');
      expect(markup).toContain(`data-task-id="${taskId}"`);
      expect(markup).toContain('data-task-status="working"');
      expect(markup).toContain('Progress 1 / 4 · waiting');
      expect(markup).toContain(`Cancel ${taskId.slice(0, 8)}`);
      expect(markup).toContain(`Fetch result ${taskId.slice(0, 8)}`);
      expect(MCP_PAGE_TASK_TTL_MS).toBe(600_000);

      // Without a tasks capability the list control stays hidden; without task history the panel does not render.
      const plain = renderToStaticMarkup(createElement(McpPage, {
        controller: { ...controller(), model: { ...model, phase: 'ready' } },
        epochOptions: ['epoch-1'],
        targetOptions: ['codex'],
      }));
      expect(plain).not.toContain('>List tasks</button>');
      expect(plain).not.toContain('aria-label="MCP tasks"');
      expect(plain).not.toContain('Run as task');
    });
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

describe('MCP page inspector launch', () => {
  const inspectorUrl = 'http://127.0.0.1:6274/?MCP_INSPECTOR_API_TOKEN=tok-123';
  const launchButton = '>Open MCP Inspector</button>';
  const linkText = 'Open MCP Inspector in a new tab</a>';

  const inspectorLaunchFor = (inspectorModel: McpInspectorLaunchModel): McpPageInspectorLaunch => ({
    launch: async () => undefined,
    model: inspectorModel,
    refresh: async () => undefined,
    subscribe: (listener) => {
      listener(inspectorModel);
      return () => undefined;
    },
  });

  const inspectorMarkup = (inspectorModel: McpInspectorLaunchModel, session: McpBrowserSessionModel = model): string => renderToStaticMarkup(createElement(McpPage, {
    controller: { ...controller(), model: session },
    epochOptions: ['epoch-1'],
    inspectorLaunch: inspectorLaunchFor(inspectorModel),
    onDownloadConfig: () => undefined,
    targetOptions: ['codex'],
  }));

  const inspectorLink = (markup: string): string => {
    const anchor = /<a [^>]*class="mcp-page-inspector-link"[^>]*>/u.exec(markup);
    if (anchor === null) throw new Error('Expected an Inspector link.');
    return anchor[0];
  };

  // Static markup escapes `&` inside attributes; undo it to parse the href as a URL.
  const inspectorHref = (anchor: string): string => {
    const href = /href="([^"]*)"/u.exec(anchor);
    if (href === null) throw new Error('Expected an Inspector link href.');
    return href[1]!.replaceAll('&amp;', '&');
  };

  it('offers a launch button while idle without a link, status line, or inspector error', () => {
    const markup = inspectorMarkup({ phase: 'idle' });

    expect(markup).toContain('<h2 id="mcp-config-heading">MCP Inspector</h2>');
    expect(markup).toContain('aria-label="Inspector actions"');
    expect(markup).toContain('never embedded here');
    expect(markup).toContain(launchButton);
    expect(markup).toContain('Download Inspector config');
    expect(markup).not.toContain(linkText);
    expect(markup).not.toContain('mcp-page-inspector-link');
    expect(markup).not.toContain('mcp-page-inspector-status');
    expect(markup).not.toContain('mcp-page-inspector-error');
  });

  it('disables the control and explains the startup budget while starting', () => {
    const markup = inspectorMarkup({ phase: 'starting' });

    expect(markup).toContain('<button disabled="" type="button">Starting MCP Inspector…</button>');
    expect(markup).toContain('<p class="mcp-page-inspector-status" role="status">Starting the MCP Inspector.');
    expect(markup).toContain('can take up to 30 seconds');
    expect(markup).not.toContain(launchButton);
    expect(markup).not.toContain(linkText);
    expect(markup).not.toContain('mcp-page-inspector-error');
  });

  it('renders a new-tab link to the tokenized Inspector URL without leaking the stdio launch', () => {
    const markup = inspectorMarkup({ phase: 'ready', url: inspectorUrl });
    const anchor = inspectorLink(markup);

    expect(anchor).toContain(`href="${inspectorUrl}"`);
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(inspectorHref(anchor)).toBe(inspectorUrl);
    expect(markup).toContain(linkText);
    expect(markup).toContain('does not start a stdio server from a link');
    expect(markup).not.toContain('serverUrl');
    expect(markup).not.toContain('autoConnect');
    expect(markup).not.toContain(launchButton);
    expect(markup).not.toContain('mcp-page-inspector-error');
    expect(markup).toContain('Download Inspector config');
  });

  it('deep-links a streamable HTTP session into the Inspector', () => {
    const serverUrl = 'http://127.0.0.1:3100/mcp/host/weather';
    const session = reducedModelForConfig({ launch: { kind: 'streamable-http', url: serverUrl }, origin: 'artifact' });
    const markup = inspectorMarkup({ phase: 'ready', url: inspectorUrl }, session);
    const anchor = inspectorLink(markup);
    const href = new URL(inspectorHref(anchor));

    expect(anchor).toContain('&amp;serverUrl=');
    expect(anchor).toContain('&amp;transport=http');
    expect(anchor).toContain('&amp;autoConnect=tok-123');
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(href.origin).toBe('http://127.0.0.1:6274');
    expect([...href.searchParams.keys()].sort()).toEqual(['MCP_INSPECTOR_API_TOKEN', 'autoConnect', 'serverUrl', 'transport']);
    expect(href.searchParams.get('MCP_INSPECTOR_API_TOKEN')).toBe('tok-123');
    expect(href.searchParams.get('serverUrl')).toBe(serverUrl);
    expect(href.searchParams.get('transport')).toBe('http');
    expect(href.searchParams.get('autoConnect')).toBe('tok-123');
    expect(markup).toContain(`The link pre-connects the Inspector to <code>${serverUrl}</code>.`);
    expect(markup).not.toContain('does not start a stdio server from a link');
  });

  it('surfaces a launch failure inline and keeps the launch button available', () => {
    const markup = inspectorMarkup({ diagnostic: { code: 'AB8112', message: 'MCP Inspector could not be launched.' }, phase: 'error' });

    expect(markup).toContain('<p class="mcp-page-inspector-error" role="alert"><strong>AB8112</strong> MCP Inspector could not be launched.</p>');
    expect(markup).toContain(launchButton);
    expect(markup).not.toContain(linkText);
    expect(markup).not.toContain('mcp-page-inspector-link');
    expect(markup).not.toContain('mcp-page-inspector-status');
  });

  it('renders only the config export when no launcher is provided', () => {
    const markup = renderToStaticMarkup(createElement(McpPage, {
      controller: controller(),
      epochOptions: ['epoch-1'],
      onDownloadConfig: () => undefined,
      targetOptions: ['codex'],
    }));

    expect(markup).toContain('<h2 id="mcp-config-heading">MCP Inspector</h2>');
    expect(markup).toContain('Download Inspector config');
    expect(markup).not.toContain('Open MCP Inspector');
    expect(markup).not.toContain('mcp-page-inspector-link');
    expect(markup).not.toContain('mcp-page-inspector-status');
    expect(markup).not.toContain('mcp-page-inspector-error');
  });
});
