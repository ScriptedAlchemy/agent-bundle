import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonValue, ProjectEventMessage, RuntimeEvent } from '../../agent-bundle/src/dev/types.ts';
import { RuntimeClientError, type RuntimeBootstrap } from '../src/runtime-client.ts';
import {
  createRuntimePlaygroundController,
  runtimeDataAttributesFor,
  runtimePlaygroundLiveMcpPageAdapter,
  RuntimePlayground,
  type RuntimePlaygroundClient,
} from '../src/runtime-playground.tsx';
import type { RuntimeProfileOption } from '../src/runtime-model.ts';

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

it('includes the Runtime Playground unit contract in its dedicated coverage selection', async () => {
  const config = await readFile(join(process.cwd(), 'rstest.runtime-playground.config.ts'), 'utf8');

  expect(config).toContain("'packages/workbench/tests/runtime-playground.test.ts'");
});

it('keeps unavailable runtime absent and composes no live MCP page adapter', () => {
  const controller = createRuntimePlaygroundController({ bootstrap: Object.freeze({ kind: 'unavailable' }), client: clientFor(), profiles });

  expect(controller.model.status).toBeUndefined();
  expect(controller.model.surfaces).toEqual([]);
  expect(runtimeDataAttributesFor(controller.model)).toEqual({});
  expect(runtimePlaygroundLiveMcpPageAdapter).toEqual({ kind: 'disabled' });
});

it('renders the available Runtime playground controls, identity, and optional capability evidence', () => {
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });

  const markup = renderToStaticMarkup(createElement(RuntimePlayground, { controller }));

  expect(markup).toContain('Runtime Playground');
  expect(markup).toContain('Optional development capability');
  expect(markup).toContain('Runtime identity');
  expect(markup).toContain('Profile simulation is evidence-only');
  expect(markup).toContain('Run history');
  expect(markup).toContain('data-runtime-provider-session="provider-a"');
  expect(markup).toContain('Loading runtime evidence…');
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
  expect(markup).toContain('disabled=""');
});

it('derives all runtime identity attributes from provider, ordered HMR, and reset evidence', async () => {
  const controller = createRuntimePlaygroundController({ bootstrap: bootstrap(), client: clientFor(), profiles });

  expect(runtimeDataAttributesFor(controller.model)).toEqual({
    'data-runtime-artifact-epoch': 'epoch-a',
    'data-runtime-event-sequence': '0',
    'data-runtime-generation': 'generation-a',
    'data-runtime-hmr-client-count': '0',
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
    'data-runtime-hmr-client-count': '0',
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
