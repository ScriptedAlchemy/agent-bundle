import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import { createElement } from 'react';
import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server';

import type {
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonValue, ProjectEventMessage, RuntimeEvent } from '../../agent-bundle/src/dev/types.ts';
import { RuntimeClientError, type RuntimeBootstrap } from '../src/runtime-client.ts';
import {
  createRuntimeEventBuffer,
  createRuntimePlaygroundController,
  runtimeBootstrapRetryPlan,
  runtimeDataAttributesFor,
  runtimePlaygroundLiveMcpPageAdapter,
  RuntimePlayground,
  type RuntimeAppPreviewLifecycleRegistrar,
  type RuntimePlaygroundClient,
} from '../src/runtime-playground.tsx';
import type { RuntimeProfileOption } from '../src/runtime-model.ts';
import type { RuntimeAppPreviewRenderer, RuntimeLiveMcpPageAdapter } from '../src/runtime-stage.tsx';

const vector = Object.freeze({
  artifactEpochId: 'epoch-a',
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'state-a',
  stateVersion: 1,
});

const status = Object.freeze({
  activeVector: vector,
  descriptor: Object.freeze({ environmentVariables: [], id: 'rsc', label: 'RSC Runtime', schemaVersion: 1 as const }),
  diagnostics: Object.freeze([]),
  hmrReady: true,
  lastGoodVector: vector,
  state: 'active' as const,
}) satisfies DevRuntimeStatus;

const surface = Object.freeze({
  defaultTarget: 'portable',
  fixtures: Object.freeze([{ id: 'fixture-a', label: 'Fixture A', seed: Object.freeze({ city: 'London' }) }]),
  id: 'hook.claude',
  inputSchema: Object.freeze({
    properties: Object.freeze({ city: Object.freeze({ title: 'City', type: 'string' as const }) }),
    required: Object.freeze(['city']),
    type: 'object' as const,
  }),
  kind: 'hook' as const,
  label: 'Claude hook',
  readOnly: true,
  targets: Object.freeze(['portable']),
}) satisfies DevRuntimeSurface;

const mutableSurface = Object.freeze({ ...surface, id: 'mcp.weather', kind: 'mcp-tool' as const, readOnly: false });

const run = (id: string, source: Partial<Extract<DevRuntimeRun, Readonly<{ readonly status: 'succeeded' }>>> = {}): DevRuntimeRun => Object.freeze({
  completedAt: '2026-08-15T12:00:01.000Z',
  fixtureId: 'fixture-a',
  id,
  input: Object.freeze({ city: 'London' }),
  result: Object.freeze({
    agentVisible: Object.freeze({ city: 'London' }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'state-a', stateVersion: 1 }) }),
    trace: Object.freeze([]),
    tree: Object.freeze([]),
  }),
  startedAt: `2026-08-15T12:${id.padStart(2, '0')}:00.000Z`,
  status: 'succeeded',
  surfaceId: 'hook.claude',
  target: 'portable',
  vector,
  ...source,
});

const profiles = Object.freeze([{
  claimsRealHostParity: false,
  evidence: 'simulated',
  id: 'portable',
  label: 'Portable MCP Apps',
  version: 'agent-bundle:mcp-apps:2026-01-26',
}] satisfies readonly RuntimeProfileOption[]);

const bootstrap = (overrides: Partial<Extract<RuntimeBootstrap, { readonly kind: 'available' }>> = {}): RuntimeBootstrap => Object.freeze({
  history: Object.freeze([run('01')]),
  kind: 'available' as const,
  providerSessionId: 'provider-a',
  status,
  surfaces: Object.freeze([surface]),
  ...overrides,
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason: unknown): void;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, reject, resolve };
};

const clientFor = (overrides: Partial<RuntimePlaygroundClient> = {}): RuntimePlaygroundClient & {
  readonly requests: Array<DevRuntimeInvocationRequest | DevRuntimeReplayRequest | DevRuntimeStateResetRequest | string>;
} => {
  const requests: Array<DevRuntimeInvocationRequest | DevRuntimeReplayRequest | DevRuntimeStateResetRequest | string> = [];
  return {
    bootstrap: async () => bootstrap(),
    createRun: async (request) => { requests.push(request); return run('created'); },
    readRun: async (id) => { requests.push(id); return run(id); },
    replayRun: async (request) => { requests.push(request); return run('replayed'); },
    requests,
    resetState: async (request) => { requests.push(request); return Object.freeze({ stateStoreId: 'state-a', stateVersion: 2 }); },
    ...overrides,
  };
};

const runtimeEvent = (sequence: number, type: RuntimeEvent['type'], runId?: string): ProjectEventMessage => Object.freeze({
  occurredAt: '2026-08-15T12:00:00.000Z',
  payload: Object.freeze({ providerSessionId: 'provider-a', ...(runId === undefined ? {} : { runId }), type }),
  sequence,
  type: 'runtime.event',
});

const renderWhenReady = async (node: React.ReactNode): Promise<string> => {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
};

it('includes the Runtime Playground unit contract in its dedicated coverage selection', async () => {
  const config = await readFile(join(process.cwd(), 'rstest.runtime-playground.config.ts'), 'utf8');

  expect(config).toContain("'packages/workbench/tests/runtime-playground.test.ts'");
  expect(config).toContain("'packages/workbench/tests/runtime-playground.browser.test.tsx'");
});

it('keeps unavailable runtime absent and composes no live MCP page adapter', () => {
  const controller = createRuntimePlaygroundController({ bootstrap: Object.freeze({ kind: 'unavailable' }), client: clientFor(), profiles });

  expect(controller.model.status).toBeUndefined();
  expect(controller.model.surfaces).toEqual([]);
  expect(runtimeDataAttributesFor(controller.model)).toEqual({});
  expect(runtimePlaygroundLiveMcpPageAdapter).toEqual({ kind: 'disabled' });
});

it('passes an explicit default profile through the Playground controller without reordering profiles', () => {
  const chatgpt = Object.freeze({
    claimsRealHostParity: false,
    evidence: 'simulated' as const,
    id: 'chatgpt',
    label: 'ChatGPT Simulation',
    version: 'agent-bundle:chatgpt-sim:1',
  });
  const orderedProfiles = Object.freeze([chatgpt, profiles[0]!]);
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: clientFor(),
    defaultProfileId: 'portable',
    profiles: orderedProfiles,
  });

  expect(controller.model.profiles.map((entry) => entry.id)).toEqual(['chatgpt', 'portable']);
  expect(controller.model.selectedProfileId).toBe('portable');
});

it('renders the available Runtime playground controls, identity, and optional capability evidence', () => {
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });

  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(markup).toContain('Runtime Playground');
  expect(markup).toContain('Optional development capability');
  expect(markup).toContain('Runtime identity');
  expect(markup).toContain('Portable MCP Apps · agent-bundle:mcp-apps:2026-01-26 · Simulation');
  expect(markup).toContain('Simulated locally — not host certification');
  expect(markup).toContain('Runtime input input mode');
  expect(markup).toContain('City');
  expect(markup).toContain('Raw JSON');
  expect(markup).toContain('Run history');
  expect(markup).toContain('data-runtime-provider-session="provider-a"');
  expect(markup).toContain('Loading runtime evidence…');
});

it('forwards the one preview renderer and exact lifecycle registrar to its sole Stage boundary without invoking either lifecycle owner', async () => {
  const appSurface = Object.freeze({ ...surface, id: 'app/customer', kind: 'mcp-app' as const, label: 'Customer App' });
  const appRun = Object.freeze({
    completedAt: '2026-08-15T12:00:01.000Z',
    fixtureId: 'fixture-a',
    id: '01',
    input: Object.freeze({ city: 'London' }),
    result: Object.freeze({
      agentVisible: Object.freeze({ city: 'London' }),
      app: Object.freeze({
        mcpBinding: Object.freeze({
          definitionDigest: 'definition',
          registryRevision: 1,
          serverDigest: 'server',
          serverName: 'customer',
          sessionId: 'session',
          sessionRevision: 1,
          target: 'portable',
          transportDigest: 'transport',
        }),
        resourceUri: 'ui://customer/app.html',
        surfaceId: 'app/customer',
      }),
      state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'state-a', stateVersion: 1 }) }),
      trace: Object.freeze([]),
      tree: Object.freeze([]),
    }),
    startedAt: '2026-08-15T12:01:00.000Z',
    status: 'succeeded' as const,
    surfaceId: 'app/customer',
    target: 'portable',
    vector,
  } satisfies DevRuntimeRun);
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap({ history: Object.freeze([appRun]), surfaces: Object.freeze([appSurface]) }),
    client: clientFor(),
    profiles,
  });
  let rendererCalls = 0;
  let handoffCalls = 0;
  let receivedHandoff: unknown;
  let registrarCalls = 0;
  let receivedRegistrar: unknown;
  const registrar: RuntimeAppPreviewLifecycleRegistrar = (_handle) => {
    registrarCalls += 1;
    return () => undefined;
  };
  const renderer: RuntimeAppPreviewRenderer = (props): React.ReactNode => {
    rendererCalls += 1;
    receivedRegistrar = props.registerLifecycle;
    return createElement('div', { 'data-runtime-app-sentinel': 'playground' }, 'Injected App');
  };
  const liveMcpPageAdapter = Object.freeze({
    kind: 'host-owned' as const,
    render: (props) => {
      handoffCalls += 1;
      receivedHandoff = props;
      return createElement('div', { 'data-runtime-mcp-page-sentinel': 'playground' }, 'Host handoff');
    },
  }) satisfies RuntimeLiveMcpPageAdapter;

  await renderWhenReady(createElement(RuntimePlayground, {
    controller,
    liveMcpPageAdapter,
    registerAppPreviewLifecycle: registrar,
    renderAppPreview: renderer,
  }));

  expect(rendererCalls).toBe(1);
  expect(handoffCalls).toBe(1);
  expect(receivedRegistrar).toBe(registrar);
  const handoff = receivedHandoff as Record<string, unknown>;
  const selectedRun = controller.model.history[0]!;
  const selectedProfile = controller.model.profiles[0]!;
  const selectedSurface = controller.model.surfaces[0]!;
  if (selectedRun.status !== 'succeeded') throw new Error('Expected the selected Runtime App run to have succeeded.');
  expect(Object.keys(handoff).sort()).toEqual(['mcpBinding', 'profile', 'profileId', 'registerLifecycle', 'run', 'surface']);
  expect(handoff.mcpBinding).toBe(selectedRun.result.app!.mcpBinding);
  expect(handoff.profile).toBe(selectedProfile);
  expect(handoff.profileId).toBe('portable');
  expect(handoff.registerLifecycle).toBe(registrar);
  expect(handoff.run).toBe(selectedRun);
  expect(handoff.surface).toBe(selectedSurface);
  expect(registrarCalls).toBe(0);
});

it('renders each ordered Runtime history item with its stable run ID', () => {
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap({ history: Object.freeze([run('02'), run('01')]) }),
    client: clientFor(),
    profiles,
  });

  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(markup).toMatch(/data-runtime-run-id="02"[\s\S]*data-runtime-run-id="01"/u);
});

it('renders validation, confirmation, replay-gap, and unavailable-identity states without hiding the Runtime shell', async () => {
  const initial = bootstrap({ status: Object.freeze({ ...status, hmrReady: false, state: 'degraded' }) });
  const controller = createRuntimePlaygroundController({
    bootstrap: initial,
    client: clientFor({ bootstrap: async () => initial }),
    profiles: Object.freeze([]),
  });
  controller.dispatch({ raw: '{', type: 'draft.raw' });
  controller.dispatch({ type: 'reset.request' });
  await controller.receive(Object.freeze({ earliestAvailableSequence: 14, latestDroppedSequence: 13, requestedAfterSequence: 10, type: 'replay.gap' as const }));

  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(markup).toContain('HMR endpoint unavailable');
  expect(markup).toContain('Not available');
  expect(markup).toContain('Draft JSON is invalid. Repair the raw input before running.');
  expect(markup).toContain('Events 11–13 were unavailable.');
  expect(markup).toContain('Reset fixture state?');
  expect(markup).toContain('State store');
  expect(markup).toContain('state-a');
  expect(markup).toContain('Fixture seed');
  expect(markup).toContain('disabled=""');
});

it('disables reset without a reducer-owned state identity and fences duplicate confirmation', async () => {
  const noState = bootstrap({ status: Object.freeze({ ...status, activeVector: undefined, lastGoodVector: undefined }) });
  const unavailableReset = createRuntimePlaygroundController({ bootstrap: noState, client: clientFor(), profiles });
  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller: unavailableReset }));
  expect(markup).toContain('Reset fixture state</button>');

  const pending = deferred<DevRuntimeStateIdentity>();
  let resetCalls = 0;
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: clientFor({ resetState: async () => { resetCalls += 1; return pending.promise; } }),
    profiles,
  });
  controller.dispatch({ type: 'reset.request' });
  controller.dispatch({ type: 'confirmation.confirm' });
  controller.dispatch({ type: 'confirmation.confirm' });
  await Promise.resolve();

  expect(resetCalls).toBe(1);
  pending.resolve(Object.freeze({ stateStoreId: 'state-a', stateVersion: 2 }));
  await controller.whenIdle();
});

it('derives all runtime identity attributes from provider, ordered HMR, and reset evidence', async () => {
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });

  expect(runtimeDataAttributesFor(controller.model)).toEqual({
    'data-runtime-artifact-epoch': 'epoch-a',
    'data-runtime-event-sequence': '0',
    'data-runtime-generation': 'generation-a',
    'data-runtime-hmr-client-count': 'Unknown',
    'data-runtime-hmr-ready': 'true',
    'data-runtime-provider-session': 'provider-a',
    'data-runtime-source-revision': 'source-a',
    'data-runtime-state-version': '1',
  });
  await controller.receive(Object.freeze({
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: Object.freeze({ details: Object.freeze({ connectionCount: 3, surfaceId: 'hook.claude' }), providerSessionId: 'provider-a', type: 'runtime.hmr.client-connected' as const }),
    sequence: 8,
    type: 'runtime.event' as const,
  }));
  controller.dispatch({ type: 'reset.request' });
  controller.dispatch({ type: 'confirmation.confirm' });
  await controller.whenIdle();

  expect(runtimeDataAttributesFor(controller.model)).toMatchObject({
    'data-runtime-event-sequence': '8',
    'data-runtime-hmr-client-count': '3',
    'data-runtime-state-version': '2',
  });
});

it('uses a succeeded App client surface, not its invoked surface, for HMR client counts', async () => {
  const appSurface = Object.freeze({
    ...mutableSurface,
    id: 'mcp.render_edit_timeline',
    label: 'Render edit timeline',
  });
  const succeeded = run('app-run');
  if (succeeded.status !== 'succeeded') throw new Error('Expected a succeeded App run fixture.');
  const appRun = Object.freeze({
    ...succeeded,
    result: Object.freeze({
      agentVisible: Object.freeze({ city: 'London' }),
      app: Object.freeze({
        mcpBinding: Object.freeze({
          definitionDigest: 'definition-app', registryRevision: 1, serverDigest: 'server-app', serverName: 'timeline',
          sessionId: 'session-app', sessionRevision: 1, target: 'portable', transportDigest: 'transport-app',
        }),
        resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
        surfaceId: 'mcp.edit-timeline',
      }),
      state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'state-a', stateVersion: 1 }) }),
      trace: Object.freeze([]),
      tree: Object.freeze([]),
    }),
    surfaceId: 'mcp.render_edit_timeline',
  }) satisfies DevRuntimeRun;
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap({ history: Object.freeze([appRun]), surfaces: Object.freeze([appSurface]) }),
    client: clientFor(),
    profiles,
  });

  await controller.receive(Object.freeze({
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: Object.freeze({ details: Object.freeze({ connectionCount: 4, surfaceId: 'mcp.edit-timeline' }), providerSessionId: 'provider-a', type: 'runtime.hmr.client-connected' as const }),
    sequence: 8,
    type: 'runtime.event' as const,
  }));

  expect(runtimeDataAttributesFor(controller.model)).toMatchObject({
    'data-runtime-hmr-client-count': '4',
  });
});

it('retains a succeeded App client surface for HMR while the selected run has failed', async () => {
  const appSurface = Object.freeze({
    ...mutableSurface,
    id: 'mcp.render_edit_timeline',
    label: 'Render edit timeline',
  });
  const succeeded = run('app-run');
  if (succeeded.status !== 'succeeded') throw new Error('Expected a succeeded App run fixture.');
  const appRun = Object.freeze({
    ...succeeded,
    result: Object.freeze({
      agentVisible: Object.freeze({ city: 'London' }),
      app: Object.freeze({
        mcpBinding: Object.freeze({
          definitionDigest: 'definition-app', registryRevision: 1, serverDigest: 'server-app', serverName: 'timeline',
          sessionId: 'session-app', sessionRevision: 1, target: 'portable', transportDigest: 'transport-app',
        }),
        resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
        surfaceId: 'mcp.edit-timeline',
      }),
      state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'state-a', stateVersion: 1 }) }),
      trace: Object.freeze([]),
      tree: Object.freeze([]),
    }),
    surfaceId: 'mcp.render_edit_timeline',
  }) satisfies DevRuntimeRun;
  const failed = Object.freeze({
    completedAt: '2026-08-15T12:01:01.000Z',
    diagnostics: Object.freeze([]),
    id: 'failed-run',
    input: Object.freeze({ city: 'London' }),
    startedAt: '2026-08-15T12:01:00.000Z',
    status: 'failed' as const,
    surfaceId: 'mcp.render_edit_timeline',
    target: 'portable',
    vector,
  }) satisfies DevRuntimeRun;
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap({ history: Object.freeze([failed, appRun]), surfaces: Object.freeze([appSurface]) }),
    client: clientFor(),
    profiles,
  });

  await controller.receive(Object.freeze({
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: Object.freeze({ details: Object.freeze({ connectionCount: 5, surfaceId: 'mcp.edit-timeline' }), providerSessionId: 'provider-a', type: 'runtime.hmr.client-connected' as const }),
    sequence: 8,
    type: 'runtime.event' as const,
  }));

  expect(runtimeDataAttributesFor(controller.model)).toMatchObject({
    'data-runtime-hmr-client-count': '5',
  });
});

it('does not present unknown HMR clients as zero and keeps the visible state version aligned after reset', async () => {
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: clientFor({ createRun: async () => run('02') }),
    profiles,
  });

  expect(runtimeDataAttributesFor(controller.model)).toMatchObject({
    'data-runtime-hmr-client-count': 'Unknown',
  });

  controller.dispatch({ type: 'reset.request' });
  controller.dispatch({ type: 'confirmation.confirm' });
  await controller.whenIdle();

  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));
  expect(markup).toContain('data-runtime-state-version="2"');
  expect(markup).toContain('<dt>State version</dt><dd>2</dd>');
});

it('renders available capability without a current vector and preserves fallback identity labels', () => {
  const withoutEpoch = Object.freeze({ ...vector, artifactEpochId: undefined });
  const noVectorStatus = Object.freeze({ ...status, activeVector: undefined, hmrReady: false, lastGoodVector: undefined, state: 'compiling' }) satisfies DevRuntimeStatus;
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap({ history: Object.freeze([]), status: noVectorStatus, surfaces: Object.freeze([]) }),
    client: clientFor(),
    profiles: Object.freeze([]),
  });
  const attributes = runtimeDataAttributesFor(Object.freeze({
    ...createRuntimePlaygroundController({ bootstrap: bootstrap({ status: Object.freeze({ ...status, activeVector: withoutEpoch }) }), client: clientFor(), profiles }).model,
    selectedSurfaceId: undefined,
    stateIdentity: undefined,
  }));
  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(attributes).toMatchObject({
    'data-runtime-artifact-epoch': 'Not packaged',
    'data-runtime-hmr-client-count': 'Unknown',
    'data-runtime-state-version': '1',
  });
  expect(markup).toContain('HMR endpoint unavailable');
  expect(markup).toContain('Provider session ID</dt><dd>Not available');
  expect(markup).not.toContain('data-runtime-provider-session');
});

it('renders provider-default fallback controls and retained announcements without inventing an App client', () => {
  const alternateSurface = Object.freeze({ ...surface, id: 'hook.cursor', label: 'Cursor hook' });
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });
  controller.dispatch({ bootstrap: bootstrap({ surfaces: Object.freeze([alternateSurface]) }), type: 'bootstrap.received' });

  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(markup).toContain('Selected runtime surface is no longer available; provider defaults were selected.');
  expect(markup).toContain('Cursor hook');
  expect(markup).not.toContain('<iframe');
});

it('renders a generation-failure alert without replacing the Result selection', () => {
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });

  controller.dispatch({ event: runtimeEvent(1, 'runtime.generation.failed'), type: 'event.received' });
  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(controller.model.selectedTab).toBe('result');
  expect(controller.model.selectedRunId).toBe('01');
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Runtime generation failed. The last good result remains available.');
});

it('renders previous-provider last-good output separately from session-only runtime history', () => {
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });
  const beforeRestartMarkup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));
  const providerBVector = Object.freeze({ ...vector, providerSessionId: 'provider-b', runtimeGenerationId: 'generation-b' });
  controller.dispatch({
    bootstrap: bootstrap({
      history: Object.freeze([]),
      providerSessionId: 'provider-b',
      status: Object.freeze({ ...status, activeVector: providerBVector, lastGoodVector: providerBVector }),
    }),
    type: 'bootstrap.received',
  });
  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(markup).toContain('Previous provider session');
  expect(markup).toContain('Last-good output from the prior provider session');
  expect(markup).toContain('Hook operation');
  expect(beforeRestartMarkup).toContain('Session-only / ephemeral — not durable artifact history');
  expect(markup).toContain('&quot;city&quot;: &quot;London&quot;');
});

it('initializes all provider history items without truncating the server-owned fifty item window', () => {
  const history = Object.freeze(Array.from({ length: 50 }, (_, index) => run(String(50 - index).padStart(2, '0'))));
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap({ history }), client: clientFor(), profiles });

  expect(controller.model.history).toHaveLength(50);
  expect(controller.model.history.map((entry) => entry.id)).toEqual(history.map((entry) => entry.id));
});

it('executes a read-only run exactly once', async () => {
  const client = clientFor();
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });

  controller.dispatch({ type: 'run.request' });
  await controller.whenIdle();

  expect(client.requests).toEqual([{
    expectedGenerationId: 'generation-a', fixtureId: 'fixture-a', input: { city: 'London' }, surfaceId: 'hook.claude', target: 'portable',
  }]);
});

it('waits for confirmation before posting a mutable run', async () => {
  const client = clientFor();
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap({ surfaces: Object.freeze([mutableSurface]) }), client, profiles });

  controller.dispatch({ type: 'run.request' });
  await controller.whenIdle();
  expect(client.requests).toEqual([]);
  controller.dispatch({ type: 'confirmation.confirm' });
  await controller.whenIdle();

  expect(client.requests).toHaveLength(1);
});

it('cancels reset, posts the exact reset request, then queues its one follow-up run', async () => {
  const client = clientFor();
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });

  controller.dispatch({ type: 'reset.request' });
  controller.dispatch({ type: 'confirmation.cancel' });
  await controller.whenIdle();
  expect(client.requests).toEqual([]);

  controller.dispatch({ type: 'reset.request' });
  controller.dispatch({ type: 'confirmation.confirm' });
  await controller.whenIdle();

  expect(client.requests).toEqual([
    { expectedGenerationId: 'generation-a', seed: { city: 'London' }, stateStoreId: 'state-a' },
    { expectedGenerationId: 'generation-a', fixtureId: 'fixture-a', input: { city: 'London' }, surfaceId: 'hook.claude', target: 'portable' },
  ]);
});

it('sends exact and latest replay bodies without broadening either request', async () => {
  const client = clientFor();
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });

  controller.dispatch({ mode: 'exact', runId: '01', type: 'replay.request' });
  await controller.whenIdle();
  controller.dispatch({ mode: 'latest', runId: '01', type: 'replay.request' });
  await controller.whenIdle();

  expect(client.requests).toEqual([
    { expectedGenerationId: 'generation-a', mode: 'exact', runId: '01' },
    { expectedGenerationId: 'generation-a', mode: 'latest', runId: '01' },
  ]);
});

it('reads a terminal event once and does not duplicate its run read', async () => {
  const client = clientFor();
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });
  const event = runtimeEvent(7, 'runtime.run.completed', 'run-event');

  await controller.receive(event);
  await controller.receive(event);

  expect(client.requests).toEqual(['run-event']);
});

it('recovers a conflict through bootstrap without re-posting the conflicted operation', async () => {
  let bootstrapCalls = 0;
  let createCalls = 0;
  const client = clientFor({
    bootstrap: async () => { bootstrapCalls += 1; return bootstrap(); },
    createRun: async (request) => {
      createCalls += 1;
      throw new RuntimeClientError({ code: 'AB8204', message: `Conflict for ${request.surfaceId}`, phase: 'provider-lifecycle' });
    },
  });
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });

  controller.dispatch({ type: 'run.request' });
  await controller.whenIdle();

  expect(bootstrapCalls).toBe(1);
  expect(createCalls).toBe(1);
  expect(client.requests).toEqual([]);
});

it('processes a replay gap bootstrap before the queued next runtime event', async () => {
  let bootstrapCalls = 0;
  const client = clientFor({ bootstrap: async () => { bootstrapCalls += 1; return bootstrap(); } });
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });
  const gap = Object.freeze({ earliestAvailableSequence: 14, latestDroppedSequence: 13, requestedAfterSequence: 10, type: 'replay.gap' as const });

  const afterGap = controller.receive(gap);
  const afterEvent = controller.receive(runtimeEvent(14, 'runtime.run.completed', 'run-after-gap'));
  await Promise.all([afterGap, afterEvent]);

  expect(bootstrapCalls).toBe(1);
  expect(controller.model.replayGap).toEqual(gap);
  expect(client.requests).toEqual(['run-after-gap']);
});

it('delivers pre-bootstrap runtime gap, activation, and terminal events before later live events', async () => {
  const gate = deferred<void>();
  const received: ProjectEventMessage[] = [];
  const buffer = createRuntimeEventBuffer();
  const gap = Object.freeze({ earliestAvailableSequence: 14, latestDroppedSequence: 13, requestedAfterSequence: 10, type: 'replay.gap' as const });
  const activation = runtimeEvent(14, 'runtime.generation.activated');
  const terminal = runtimeEvent(15, 'runtime.run.completed', 'queued-run');
  const live = runtimeEvent(16, 'runtime.run.failed', 'live-run');

  buffer.receive(gap);
  buffer.receive(activation);
  buffer.receive(terminal);
  await buffer.whenIdle();
  buffer.install({
    receive: async (event) => {
      received.push(event);
      if (event.type === 'replay.gap') await gate.promise;
    },
  });
  buffer.receive(live);
  await Promise.resolve();
  expect(received).toEqual([gap]);

  gate.resolve();
  await buffer.whenIdle();

  expect(received).toEqual([gap, activation, terminal, live]);
});

it('bounds pre-controller ingress, retains replay repair, and publishes its receiver only after FIFO drain', async () => {
  const gate = deferred<void>();
  const received: ProjectEventMessage[] = [];
  const replacement: ProjectEventMessage[] = [];
  const buffer = createRuntimeEventBuffer({ maximumPendingEvents: 2 });
  const first = runtimeEvent(10, 'runtime.run.completed', 'first');
  const gap = Object.freeze({ earliestAvailableSequence: 12, latestDroppedSequence: 11, requestedAfterSequence: 9, type: 'replay.gap' as const });
  const second = runtimeEvent(12, 'runtime.run.completed', 'second');
  const third = runtimeEvent(13, 'runtime.run.completed', 'third');
  const ordinary = Object.freeze({
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: Object.freeze({ occurredAt: '2026-08-15T12:00:00.000Z', paths: Object.freeze([]), reason: 'initial' as const }),
    sequence: 9,
    type: 'source.changed' as const,
  });

  buffer.receive(ordinary);
  buffer.receive(first);
  buffer.receive(gap);
  buffer.receive(second);
  buffer.install({
    receive: async (event) => {
      received.push(event);
      if (event.type === 'replay.gap') await gate.promise;
    },
  });
  buffer.install({ receive: async (event) => { replacement.push(event); } });
  buffer.receive(third);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(received).toEqual([gap]);
  gate.resolve();
  await buffer.whenIdle();
  expect(received).toEqual([gap, second, third]);
  expect(replacement).toEqual([]);

  buffer.close();
  buffer.receive(runtimeEvent(14, 'runtime.run.completed', 'dropped-after-close'));
  await buffer.whenIdle();
  expect(received).toEqual([gap, second, third]);
});

it('repairs local pre-controller eviction before advancing the runtime cursor through retained events', async () => {
  let observedCursor: number | undefined;
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: clientFor({
      bootstrap: async () => {
        observedCursor = controller.model.lastConsumedEventSequence;
        return bootstrap();
      },
    }),
    profiles,
  });
  const buffer = createRuntimeEventBuffer({ maximumPendingEvents: 2 });

  buffer.receive(runtimeEvent(10, 'runtime.hmr.client-connected'));
  buffer.receive(runtimeEvent(11, 'runtime.hmr.client-connected'));
  buffer.receive(runtimeEvent(12, 'runtime.hmr.client-connected'));
  buffer.install(controller);
  await buffer.whenIdle();
  await controller.whenIdle();

  expect(observedCursor).toBe(0);
  expect(controller.model.replayGap).toEqual({ earliestAvailableSequence: 11, latestDroppedSequence: 10, requestedAfterSequence: 9, type: 'replay.gap' });
  expect(controller.model.lastConsumedEventSequence).toBe(12);
});

it('expands a provider replay gap when bounded ingress later evicts another event', async () => {
  const received: ProjectEventMessage[] = [];
  const buffer = createRuntimeEventBuffer({ maximumPendingEvents: 2 });
  const gap = Object.freeze({ earliestAvailableSequence: 12, latestDroppedSequence: 11, requestedAfterSequence: 9, type: 'replay.gap' as const });
  const twelve = runtimeEvent(12, 'runtime.hmr.client-connected');
  const thirteen = runtimeEvent(13, 'runtime.hmr.client-connected');
  const fourteen = runtimeEvent(14, 'runtime.hmr.client-connected');

  buffer.receive(gap);
  buffer.receive(twelve);
  buffer.receive(thirteen);
  buffer.receive(fourteen);
  buffer.install({ receive: async (event) => { received.push(event); } });
  await buffer.whenIdle();

  expect(received).toEqual([
    { earliestAvailableSequence: 13, latestDroppedSequence: 12, requestedAfterSequence: 9, type: 'replay.gap' },
    thirteen,
    fourteen,
  ]);
});

it('closes pre-controller Runtime ingress after the third failed bootstrap without closing an installed receiver', async () => {
  const retryPlans = [
    runtimeBootstrapRetryPlan(0, false),
    runtimeBootstrapRetryPlan(1, false),
    runtimeBootstrapRetryPlan(2, false),
  ];

  expect(retryPlans).toEqual([
    { closePreControllerIngress: false, delay: 250, retryCount: 1 },
    { closePreControllerIngress: false, delay: 500, retryCount: 2 },
    { closePreControllerIngress: true, delay: undefined, retryCount: 2 },
  ]);
  expect(runtimeBootstrapRetryPlan(2, true)).toEqual({ closePreControllerIngress: false, delay: undefined, retryCount: 2 });

  const buffer = createRuntimeEventBuffer({ maximumPendingEvents: 2 });
  const delivered: ProjectEventMessage[] = [];
  if (retryPlans[2]!.closePreControllerIngress) buffer.close();
  buffer.receive(runtimeEvent(3, 'runtime.generation.activated'));
  buffer.install({ receive: async (event) => { delivered.push(event); } });
  await buffer.whenIdle();

  expect(delivered).toEqual([]);
});

it('ignores a late resolution after unmount', async () => {
  const pending = deferred<DevRuntimeRun>();
  const client = clientFor({ createRun: async () => pending.promise });
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });

  controller.dispatch({ type: 'run.request' });
  await Promise.resolve();
  controller.close();
  pending.resolve(run('late'));
  await Promise.resolve();

  expect(controller.model.history.map((entry) => entry.id)).toEqual(['01']);
});

it('settles queued event and foreground failures safely when the controller is closed', async () => {
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });
  const queued = controller.receive(runtimeEvent(7, 'runtime.run.completed', 'closed-event'));

  controller.close();
  await queued;
  expect(controller.error).toBeUndefined();
  expect(controller.model.history.map((entry) => entry.id)).toEqual(['01']);

  const pending = deferred<DevRuntimeRun>();
  const foreground = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor({ createRun: async () => pending.promise }), profiles });
  foreground.dispatch({ type: 'run.request' });
  await Promise.resolve();
  foreground.close();
  pending.reject(new Error('late failure'));
  await Promise.resolve();

  expect(foreground.error).toBeUndefined();
  expect(foreground.model.history.map((entry) => entry.id)).toEqual(['01']);
});

it('records a reducer failure without allowing a later event to break the FIFO tail', async () => {
  const details = Object.create(null) as Record<string, JsonValue>;
  Object.defineProperty(details, 'surfaceId', { get: () => { throw new Error('malformed provider event'); } });
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });
  const malformed = Object.freeze({
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: Object.freeze({ details, providerSessionId: 'provider-a', type: 'runtime.hmr.client-connected' as const }),
    sequence: 7,
    type: 'runtime.event' as const,
  });

  await expect(controller.receive(malformed)).rejects.toThrow('malformed provider event');
  await controller.receive(runtimeEvent(8, 'runtime.run.completed', 'after-error'));

  expect(controller.error).toBe('malformed provider event');
  expect(controller.model.history.map((entry) => entry.id)).toContain('after-error');
});

it('notifies active subscribers, settles ordinary client errors, and ignores work after close', async () => {
  const client = clientFor({ createRun: async () => { throw 'transient runtime failure'; } });
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client, profiles });
  const states: string[] = [];
  const unsubscribe = controller.subscribe((model) => states.push(model.draft.raw));

  controller.dispatch({ raw: '{"city":"Paris"}', type: 'draft.raw' });
  unsubscribe();
  controller.dispatch({ type: 'run.request' });
  await controller.whenIdle();

  expect(states).toEqual(['{"city":"Paris"}']);
  expect(controller.error).toBe('Runtime request could not be completed.');
  controller.close();
  controller.dispatch({ raw: '{"city":"Rome"}', type: 'draft.raw' });
  await controller.receive(runtimeEvent(8, 'runtime.run.completed', 'ignored'));

  expect(controller.model.draft.raw).toBe('{"city":"Paris"}');
});
