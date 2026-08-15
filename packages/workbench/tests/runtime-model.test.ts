import { expect, it } from '@rstest/core';

import type {
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStatus,
  DevRuntimeSurface,
  JsonValue,
  RuntimeVector,
} from '../../agent-bundle/src/dev/index.ts';
import type { ProjectEventMessage } from '../../agent-bundle/src/dev/types.ts';
import type { RuntimeBootstrap } from '../src/runtime-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { RuntimeClient } from '../src/runtime-client.ts';
import {
  createRuntimeModel,
  effectFor,
  reduceRuntimeModel,
  type RuntimeModel,
  type RuntimeProfileOption,
} from '../src/runtime-model.ts';

const profiles = Object.freeze([
  Object.freeze({ claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable', version: '1' }),
  Object.freeze({ claimsRealHostParity: false, evidence: 'simulated', id: 'chatgpt', label: 'ChatGPT', version: '1' }),
] satisfies readonly RuntimeProfileOption[]);

const vector = (overrides: Partial<RuntimeVector> = {}): RuntimeVector => ({
  artifactEpochId: 'epoch-a',
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'state-a',
  stateVersion: 1,
  ...overrides,
});

const status = (overrides: Partial<DevRuntimeStatus> = {}): DevRuntimeStatus => ({
  activeVector: vector(),
  descriptor: { environmentVariables: [], id: 'rsc', label: 'RSC Runtime', schemaVersion: 1 },
  diagnostics: [],
  hmrReady: true,
  lastGoodVector: vector(),
  state: 'active',
  ...overrides,
});

const surface = (overrides: Partial<DevRuntimeSurface> = {}): DevRuntimeSurface => ({
  defaultTarget: 'portable',
  fixtures: [
    { id: 'fixture-a', label: 'Fixture A', seed: { city: 'London' } },
    { id: 'fixture-b', label: 'Fixture B', seed: { city: 'Paris' } },
  ],
  id: 'weather',
  inputSchema: { type: 'object' },
  kind: 'mcp-app',
  label: 'Weather',
  readOnly: false,
  targets: ['portable', 'chatgpt'],
  ...overrides,
});

const run = (id: string, overrides: Partial<DevRuntimeRun> = {}): DevRuntimeRun => ({
  completedAt: '2026-08-15T12:00:01.000Z',
  fixtureId: 'fixture-a',
  id,
  input: { city: 'London' },
  result: {
    agentVisible: { summary: id },
    flight: { bytes: 8, preview: 'flight', truncated: false },
    modelVisible: { summary: id },
    native: { native: id },
    protocol: { jsonrpc: '2.0', id },
    state: { identity: { stateStoreId: 'state-a', stateVersion: 1 }, snapshot: { city: 'London' } },
    trace: [{ details: { id }, durationMs: 1, id: `trace-${id}`, phase: 'rsc-render', startedAt: '2026-08-15T12:00:00.000Z', status: 'succeeded' }],
    tree: [{ children: [{ children: [], id: `value-${id}`, kind: 'value', label: id, props: { id } }], id: `tree-${id}`, kind: 'component', label: 'Weather', props: { city: 'London' } }],
  },
  startedAt: '2026-08-15T12:00:00.000Z',
  status: 'succeeded',
  surfaceId: 'weather',
  target: 'portable',
  vector: vector(),
  ...overrides,
} as DevRuntimeRun);

const bootstrap = (overrides: Partial<Extract<RuntimeBootstrap, { readonly kind: 'available' }>> = {}): RuntimeBootstrap => ({
  history: [run('run-a')],
  kind: 'available',
  providerSessionId: 'provider-a',
  status: status(),
  surfaces: [surface()],
  ...overrides,
});

const model = (overrides: Parameters<typeof bootstrap>[0] = {}): RuntimeModel =>
  createRuntimeModel({ bootstrap: bootstrap(overrides), profiles });

const event = (
  sequence: number,
  type: Extract<ProjectEventMessage, { readonly type: 'runtime.event' }>['payload']['type'],
  details?: Record<string, JsonValue>,
  providerSessionId = 'provider-a',
  runtimeGenerationId = 'generation-a',
): ProjectEventMessage => ({
  occurredAt: '2026-08-15T12:00:00.000Z',
  payload: { ...(details === undefined ? {} : { details }), providerSessionId, runtimeGenerationId, type },
  sequence,
  type: 'runtime.event',
});

const reduce = (state: RuntimeModel, ...actions: Parameters<typeof reduceRuntimeModel>[1][]): RuntimeModel =>
  actions.reduce(reduceRuntimeModel, state);

const clientFor = (routes: Readonly<Record<string, unknown>>): RuntimeClient => new RuntimeClient(new ForegroundRouteClient({
  fetch: async (input) => {
    const url = String(input);
    if (url === '/api/project/session') return Response.json({ origin: 'http://localhost', token: 'token' });
    const response = routes[url];
    if (response instanceof Response) return response;
    if (response === undefined) throw new Error(`Unexpected route ${url}.`);
    return Response.json(response);
  },
}));

it('bootstraps provider defaults and caps, deduplicates, orders, and snapshots history', () => {
  const entries = Array.from({ length: 52 }, (_, index) => run(`run-${index}`, {
    startedAt: `2026-08-15T12:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  const state = model({ history: [...entries, run('run-51', { startedAt: '2026-08-15T12:51:00.000Z' })] });

  expect(state.selectedSurfaceId).toBe('weather');
  expect(state.selectedFixtureId).toBe('fixture-a');
  expect(state.selectedTarget).toBe('portable');
  expect(state.selectedProfileId).toBe('portable');
  expect(state.history).toHaveLength(50);
  expect(state.history[0]?.id).toBe('run-51');
  expect(state.history.some((entry) => entry.id === 'run-0')).toBe(false);
  expect(Object.isFrozen(state.history)).toBe(true);
  const newest = state.history[0];
  if (newest === undefined || newest.status !== 'succeeded') throw new Error('Expected a succeeded newest history entry.');
  expect(Object.isFrozen(newest)).toBe(true);
  expect(Object.isFrozen(newest.result)).toBe(true);
  expect(Object.isFrozen(newest.result.tree[0]!)).toBe(true);
  expect(Object.isFrozen(newest.result.protocol!)).toBe(true);
  expect(Object.isFrozen(newest.result.state)).toBe(true);
  expect(Object.isFrozen(newest.result.trace[0]!)).toBe(true);
});

it('keeps fixture and historical inputs immutable while raw draft repair is controlled separately', () => {
  const original = model();
  const edited = reduce(original, { input: { city: 'Rome' }, raw: '{"city":"Rome"}', type: 'draft.replace' });
  const invalid = reduce(edited, { raw: '{', type: 'draft.raw' });
  const fromHistory = reduce(invalid, { runId: 'run-a', type: 'draft.from-run' });

  expect(original.surfaces[0]!.fixtures[0]!.seed).toEqual({ city: 'London' });
  expect(original.history[0]!.input).toEqual({ city: 'London' });
  expect(edited.draft.input).toEqual({ city: 'Rome' });
  expect(invalid.draft.input).toEqual({ city: 'Rome' });
  expect(invalid.draft.raw).toBe('{');
  expect(invalid.draft.error).toBeDefined();
  expect(fromHistory.draft.input).toEqual({ city: 'London' });
  expect(fromHistory.draft.input).not.toBe(original.history[0]!.input);
});

it('appends a late completion without replacing the user selection and keeps last-good output on failure', () => {
  const first = run('run-first', { startedAt: '2026-08-15T12:02:00.000Z' });
  const second = run('run-second', { startedAt: '2026-08-15T12:03:00.000Z' });
  const original = model({ history: [first, second] });
  const selected = reduce(original, { runId: 'run-first', type: 'selection.run' });
  const late = reduce(selected, { run: run('run-late', { startedAt: '2026-08-15T12:04:00.000Z' }), type: 'run.received' });
  const failed = reduce(late, {
    run: {
      ...run('run-failed', { startedAt: '2026-08-15T12:05:00.000Z' }),
      diagnostics: [{ code: 'FAIL', message: 'No output', phase: 'rsc-render', severity: 'error' }],
      result: undefined,
      status: 'failed',
    } as DevRuntimeRun,
    type: 'run.received',
  });

  expect(late.history[0]?.id).toBe('run-late');
  expect(late.selectedRunId).toBe('run-first');
  expect(failed.lastGoodRunId).toBe('run-late');
  expect(failed.history[0]?.status).toBe('failed');
});

it('uses the original vector for exact replay and the active generation for latest replay', () => {
  const old = run('run-old', { vector: vector({ runtimeGenerationId: 'generation-old' }) });
  const state = model({ history: [old], status: status({ activeVector: vector({ runtimeGenerationId: 'generation-new' }) }) });
  const exact = reduce(state, { mode: 'exact', runId: 'run-old', type: 'replay.request' });
  const latest = reduce(exact, { id: effectFor(exact)!.id, type: 'effect.settled' }, { mode: 'latest', runId: 'run-old', type: 'replay.request' });

  expect(effectFor(exact)).toMatchObject({ kind: 'replay-run', request: { expectedGenerationId: 'generation-old', mode: 'exact', runId: 'run-old' } });
  expect(effectFor(latest)).toMatchObject({ kind: 'replay-run', request: { expectedGenerationId: 'generation-new', mode: 'latest', runId: 'run-old' } });
});

it('ignores lower or equal runtime event sequences and coalesces activation bootstrap to the newest generation', () => {
  const original = model();
  const first = reduce(original, { event: event(3, 'runtime.generation.activated', undefined, 'provider-a', 'generation-b'), type: 'event.received' });
  const lower = reduce(first, { event: event(2, 'runtime.generation.activated', undefined, 'provider-a', 'generation-c'), type: 'event.received' });
  const newest = reduce(lower, { event: event(4, 'runtime.generation.activated', undefined, 'provider-a', 'generation-d'), type: 'event.received' });
  const afterFirst = reduce(newest, { id: effectFor(newest)!.id, type: 'effect.settled' });

  expect(lower).toBe(first);
  expect(newest.lastConsumedEventSequence).toBe(4);
  expect(effectFor(newest)).toMatchObject({ kind: 'bootstrap', triggerSequence: 3 });
  expect(afterFirst.activeEffect).toMatchObject({ kind: 'bootstrap', triggerSequence: 4 });
  expect(afterFirst.pendingEffect).toBeUndefined();
});

it('turns a replay gap into exactly one bootstrap and clears HMR connection knowledge', () => {
  const connected = reduce(model(), { event: event(1, 'runtime.hmr.client-connected', { connectionCount: 2, surfaceId: 'weather' }), type: 'event.received' });
  const gap = { earliestAvailableSequence: 6, latestDroppedSequence: 5, requestedAfterSequence: 1, type: 'replay.gap' } as const;
  const first = reduce(connected, { event: gap, type: 'event.received' });
  const second = reduce(first, { event: gap, type: 'event.received' });

  expect(connected.hmrClientCountBySurface.weather).toBe(2);
  expect(connected.hmrClientCountKnownSurfaces).toEqual(['weather']);
  expect(first.replayGap).toEqual(gap);
  expect(first.hmrClientCountKnownSurfaces).toEqual([]);
  expect(first.activeEffect).toMatchObject({ kind: 'bootstrap' });
  expect(second).toBe(first);
});

it('uses ordered HMR count replacements and never treats hmrReady as a browser connection', () => {
  const original = model({ status: status({ hmrReady: true }) });
  const connected = reduce(original, { event: event(1, 'runtime.hmr.client-connected', { connectionCount: 4, surfaceId: 'weather' }), type: 'event.received' });
  const disconnected = reduce(connected, { event: event(2, 'runtime.hmr.client-disconnected', { connectionCount: 1, surfaceId: 'weather' }), type: 'event.received' });

  expect(original.hmrClientCountKnownSurfaces).toEqual([]);
  expect(disconnected.hmrClientCountBySurface.weather).toBe(1);
  expect(disconnected.hmrClientCountKnownSurfaces).toEqual(['weather']);
});

it('requires confirmation for a mutable run and retains the draft after a conflict without retrying', () => {
  const requested = reduce(model(), { type: 'run.request' });
  const confirmed = reduce(requested, { type: 'confirmation.confirm' });
  const conflicted = reduce(confirmed, { id: effectFor(confirmed)!.id, type: 'effect.conflict' });

  expect(requested.confirmation).toMatchObject({ kind: 'run' });
  expect(effectFor(requested)).toBeUndefined();
  expect(effectFor(confirmed)).toMatchObject({ kind: 'create-run', request: { expectedGenerationId: 'generation-a', fixtureId: 'fixture-a' } });
  expect(conflicted.confirmation).toBeUndefined();
  expect(conflicted.draft).toEqual(model().draft);
  expect(effectFor(conflicted)).toMatchObject({ kind: 'bootstrap' });
  expect(conflicted.pendingEffect).toBeUndefined();
});

it('requires reset confirmation, supports cancellation, queues reset cause run after success, and does not retry a reset conflict', () => {
  const requested = reduce(model(), { type: 'reset.request' });
  const cancelled = reduce(requested, { type: 'confirmation.cancel' });
  const confirmed = reduce(requested, { type: 'confirmation.confirm' });
  const identity = { stateStoreId: 'state-a', stateVersion: 2 } satisfies DevRuntimeStateIdentity;
  const succeeded = reduce(confirmed, { id: effectFor(confirmed)!.id, state: identity, type: 'reset.received' });
  const conflict = reduce(confirmed, { id: effectFor(confirmed)!.id, type: 'effect.conflict' });

  expect(requested.confirmation).toMatchObject({
    kind: 'reset',
    request: { expectedGenerationId: 'generation-a', seed: { city: 'London' }, stateStoreId: 'state-a' },
  });
  expect(effectFor(cancelled)).toBeUndefined();
  expect(effectFor(confirmed)).toMatchObject({ kind: 'reset-state' });
  expect(succeeded.stateIdentity).toEqual(identity);
  expect(succeeded.activeEffect).toMatchObject({ cause: 'reset', kind: 'create-run' });
  expect(succeeded.confirmation).toBeUndefined();
  expect(conflict.activeEffect).toMatchObject({ kind: 'bootstrap' });
  expect(conflict.history).toEqual(confirmed.history);
});

it('preserves valid selection through HMR and falls back with a visible announcement when a surface disappears', () => {
  const selected = reduce(model(),
    { fixtureId: 'fixture-b', type: 'selection.fixture' },
    { profileId: 'chatgpt', type: 'selection.profile' },
    { spanId: 'trace-run-a', type: 'trace.toggle' },
  );
  const preserved = reduce(selected, { bootstrap: bootstrap({ history: [run('run-a')], status: status({ activeVector: vector({ runtimeGenerationId: 'generation-b' }) }) }), type: 'bootstrap.received' });
  const fallback = reduce(preserved, {
    bootstrap: bootstrap({
      history: [run('other', { surfaceId: 'other', target: 'claude' })],
      surfaces: [surface({ defaultTarget: 'claude', fixtures: [], id: 'other', targets: ['claude'] })],
    }),
    type: 'bootstrap.received',
  });

  expect(preserved.selectedFixtureId).toBe('fixture-b');
  expect(preserved.selectedProfileId).toBe('chatgpt');
  expect(preserved.expandedTraceSpanIds).toEqual(['trace-run-a']);
  expect(preserved.staleIdentity).toMatchObject({ selected: { runtimeGenerationId: 'generation-a' }, current: { runtimeGenerationId: 'generation-b' } });
  expect(fallback.selectedSurfaceId).toBe('other');
  expect(fallback.selectedTarget).toBe('claude');
  expect(fallback.announcements.at(-1)).toMatch(/surface/i);
});

it('clears incompatible provider history and retains a labelled previous last-good snapshot until the new provider succeeds', () => {
  const current = model({ history: [run('last-good')] });
  const restarted = reduce(current, {
    bootstrap: bootstrap({
      history: [run('new-running', { status: 'running', vector: vector({ providerSessionId: 'provider-b', runtimeGenerationId: 'generation-b' }) })],
      providerSessionId: 'provider-b',
      status: status({ activeVector: vector({ providerSessionId: 'provider-b', runtimeGenerationId: 'generation-b' }) }),
    }),
    type: 'bootstrap.received',
  });
  const recovered = reduce(restarted, { run: run('new-good', { vector: vector({ providerSessionId: 'provider-b', runtimeGenerationId: 'generation-b' }) }), type: 'run.received' });

  expect(restarted.history.map((entry) => entry.id)).toEqual(['new-running']);
  expect(restarted.previousProviderLastGood).toMatchObject({ label: 'Previous provider session', run: { id: 'last-good' } });
  expect(restarted.hmrClientCountKnownSurfaces).toEqual([]);
  expect(recovered.previousProviderLastGood).toBeUndefined();
});

it('keeps unavailable bootstrap and invalid reducer controls inert while read-only runs skip confirmation', () => {
  const unavailable = createRuntimeModel({ bootstrap: { kind: 'unavailable' }, profiles });
  const inert = reduce(unavailable,
    { profileId: 'missing', type: 'selection.profile' },
    { runId: 'missing', type: 'selection.run' },
    { raw: 'not-json', type: 'draft.raw' },
    { type: 'run.request' },
    { type: 'reset.request' },
  );
  const readOnly = model({ surfaces: [surface({ readOnly: true })] });
  const started = reduce(readOnly, { type: 'run.request' });

  expect(inert.providerSessionId).toBeUndefined();
  expect(effectFor(inert)).toBeUndefined();
  expect(inert.draft.error).toBeDefined();
  expect(effectFor(started)).toMatchObject({ cause: 'manual', kind: 'create-run' });
});

it('rejects non-JSON snapshots and validates foreign history and run provider identities', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => reduce(model(), { input: circular as JsonValue, raw: '{}', type: 'draft.replace' })).toThrow(/cyclic/i);
  expect(() => createRuntimeModel({
    bootstrap: bootstrap({ history: [run('foreign', { vector: vector({ providerSessionId: 'other' }) })] }),
    profiles,
  })).toThrow(/provider session/i);
  expect(() => reduce(model(), { run: run('foreign', { vector: vector({ providerSessionId: 'other' }) }), type: 'run.received' })).toThrow(/provider session/i);
  expect(() => createRuntimeModel({ bootstrap: bootstrap(), profiles: [...profiles, profiles[0]!] })).toThrow(/unique simulated/i);
});

it('handles foreign and run lifecycle events through browser-only effects without fabricating HMR counts', () => {
  const foreign = reduce(model(), { event: event(1, 'runtime.status', undefined, 'provider-b', 'generation-b'), type: 'event.received' });
  const started = reduce(model(), { event: event(1, 'runtime.run.started', undefined, 'provider-a', 'generation-a'), type: 'event.received' });
  const malformedHmr = reduce(model(), { event: event(1, 'runtime.hmr.client-connected', { surfaceId: 'weather' }), type: 'event.received' });
  const generic = reduce(model(), { event: event(1, 'runtime.mcp.ready'), type: 'event.received' });

  expect(effectFor(foreign)).toMatchObject({ kind: 'bootstrap', triggerSequence: 1 });
  expect(foreign.hmrClientCountKnownSurfaces).toEqual([]);
  expect(effectFor(started)).toMatchObject({ kind: 'bootstrap', triggerSequence: 1 });
  expect(malformedHmr.hmrClientCountKnownSurfaces).toEqual([]);
  expect(effectFor(generic)).toMatchObject({ kind: 'bootstrap', triggerSequence: 1 });
});

it('parses running and failed provider runs, optional runtime metadata, reset identity, and a foreign post-bootstrap result', async () => {
  const optionalStatus = status({ activeVector: undefined, lastGoodVector: undefined, state: 'starting' });
  const optionalSurface = surface({ defaultTarget: undefined, fixtures: [{ id: 'seedless', label: 'Seedless' }], inputSchema: undefined, targets: ['portable'] });
  const running = { ...run('running'), completedAt: undefined, result: undefined, status: 'running' } as DevRuntimeRun;
  const failed = {
    ...run('failed'),
    diagnostics: [{ code: 'FAILED', message: 'Failed', phase: 'rsc-render', severity: 'error' }],
    result: undefined,
    status: 'failed',
  } as DevRuntimeRun;
  const client = clientFor({
    '/api/runtime/runs?limit=50': { providerSessionId: 'provider-a', runs: [running] },
    '/api/runtime/status': { status: optionalStatus },
    '/api/runtime/surfaces': { surfaces: [optionalSurface] },
    '/api/runtime/runs': { run: failed },
    '/api/runtime/runs/running': { run: running },
    '/api/runtime/state/reset': { state: { stateStoreId: 'state-b', stateVersion: 4 } },
  });

  await expect(client.bootstrap()).resolves.toMatchObject({ history: [{ status: 'running' }], kind: 'available' });
  await expect(client.createRun({ input: {}, surfaceId: 'weather', target: 'portable' })).resolves.toMatchObject({ status: 'failed' });
  await expect(client.readRun('running')).resolves.toMatchObject({ status: 'running' });
  await expect(client.resetState({ stateStoreId: 'state-b' })).resolves.toEqual({ stateStoreId: 'state-b', stateVersion: 4 });

  const foreign = clientFor({
    '/api/runtime/runs?limit=50': { providerSessionId: 'provider-a', runs: [run('initial')] },
    '/api/runtime/status': { status: status() },
    '/api/runtime/surfaces': { surfaces: [surface()] },
    '/api/runtime/runs/foreign': { run: run('foreign', { vector: vector({ providerSessionId: 'provider-b' }) }) },
  });
  await foreign.bootstrap();
  await expect(foreign.readRun('foreign')).rejects.toMatchObject({ code: 'AB8206' });
});

it('rejects invalid wrapper, opaque path, and asset headers through the public RuntimeClient boundary', async () => {
  await expect(clientFor({ '/api/runtime/status': { nope: true } }).bootstrap()).rejects.toMatchObject({ code: 'AB8206' });
  await expect(clientFor({ '/api/runtime/runs/..': { run: run('x') } }).readRun('..')).rejects.toMatchObject({ code: 'AB8206' });
  const assetClient = clientFor({
    '/api/runtime/assets/weather/assets/main.js?generation=generation-a': new Response(new Uint8Array([1]), {
      headers: { 'content-length': '-1', 'content-type': 'application/javascript' },
    }),
  });
  await expect(assetClient.readAsset({ path: ['assets', 'main.js'], runtimeGenerationId: 'generation-a', surfaceId: 'weather' })).rejects.toMatchObject({ code: 'AB8206' });
  await expect(assetClient.readAsset({ path: [], runtimeGenerationId: 'generation-a', surfaceId: 'weather' })).rejects.toMatchObject({ code: 'AB8206' });
});

it('covers runtime reducer invalid controls, ordered read effects, and settled lifecycle branches', () => {
  const targetless = model({ surfaces: [surface({ defaultTarget: undefined, targets: [] })] });
  const selected = reduce(model(),
    { surfaceId: 'weather', type: 'selection.surface' },
    { target: 'chatgpt', type: 'selection.target' },
    { tab: 'tree', type: 'selection.tab' },
  );
  const runEvent: ProjectEventMessage = {
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: { providerSessionId: 'provider-a', runId: 'run-a', runtimeGenerationId: 'generation-a', type: 'runtime.run.completed' },
    sequence: 1,
    type: 'runtime.event',
  };
  const reading = reduce(model(), { event: runEvent, type: 'event.received' });
  const settled = reduce(reading, { run: run('run-a'), type: 'run.received' });
  const resetBase = model();
  const confirmationBase = model();
  const badReset = reduce(resetBase, { id: 'missing', state: { stateStoreId: 'state-a', stateVersion: 2 }, type: 'reset.received' });
  const noConfirmation = reduce(confirmationBase, { type: 'confirmation.confirm' });

  expect(targetless.selectedTarget).toBeUndefined();
  expect(selected.selectedTarget).toBe('chatgpt');
  expect(selected.selectedTab).toBe('tree');
  expect(effectFor(reading)).toMatchObject({ kind: 'read-run', runId: 'run-a' });
  expect(effectFor(settled)).toBeUndefined();
  expect(badReset).toBe(resetBase);
  expect(noConfirmation).toBe(confirmationBase);
  expect(() => reduce(model(), { input: Number.NaN as unknown as JsonValue, raw: 'NaN', type: 'draft.replace' })).toThrow(/finite/i);
});

it('parses optional App inspection evidence and rejects every provider envelope layer through public routes', async () => {
  const original = run('app-evidence');
  if (original.status !== 'succeeded') throw new Error('Expected succeeded fixture.');
  const appResult = {
    ...original.result,
    app: {
        mcpBinding: {
          definitionDigest: 'definition-a',
          registryRevision: 1,
          serverDigest: 'server-a',
          serverName: 'weather',
          sessionId: 'session-a',
          sessionRevision: 1,
          target: 'portable',
          transportDigest: 'transport-a',
        },
        resourceUri: 'ui://weather/app.html',
        surfaceId: 'weather',
    },
    flight: { bytes: 8, downloadPath: '/api/runtime/assets/weather/flight', preview: 'flight', truncated: false },
  };
  const withApp = {
    ...original,
    result: appResult,
  } satisfies DevRuntimeRun;
  await expect(clientFor({ '/api/runtime/runs': { run: withApp } }).createRun({ input: {}, surfaceId: 'weather', target: 'portable' }))
    .resolves.toMatchObject({ result: { app: { resourceUri: 'ui://weather/app.html' } } });

  const invalidBootstrap = async (statusBody: unknown, surfacesBody: unknown = { surfaces: [surface()] }, runsBody: unknown = { providerSessionId: 'provider-a', runs: [run('base')] }): Promise<void> => {
    await expect(clientFor({
      '/api/runtime/runs?limit=50': runsBody,
      '/api/runtime/status': statusBody,
      '/api/runtime/surfaces': surfacesBody,
    }).bootstrap()).rejects.toMatchObject({ code: 'AB8206' });
  };
  await invalidBootstrap({ status: { ...status(), state: 'unknown' } });
  await invalidBootstrap({ status: status() }, { surfaces: [{ ...surface(), targets: ['portable', 'portable'] }] });
  await invalidBootstrap({ status: status() }, { surfaces: [{ ...surface(), fixtures: [{ id: '', label: 'bad' }] }] });
  await invalidBootstrap({ status: status() }, { surfaces: [{ ...surface(), defaultTarget: 'claude' }] });
  await invalidBootstrap({ status: status() }, undefined, { runs: [] });

  const invalidRun = async (entry: unknown): Promise<void> => {
    await expect(clientFor({ '/api/runtime/runs': { run: entry } }).createRun({ input: {}, surfaceId: 'weather', target: 'portable' })).rejects.toMatchObject({ code: 'AB8206' });
  };
  await invalidRun({ ...run('bad-run'), status: 'unknown' });
  await invalidRun({ ...withApp, result: { ...appResult, tree: [{ children: [], id: '', kind: 'component', label: 'bad' }] } });
  await invalidRun({ ...withApp, result: { ...appResult, trace: [{ id: 'trace', phase: 'rsc', startedAt: 'no-date', status: 'succeeded' }] } });
  await invalidRun({ ...withApp, result: { ...appResult, app: { ...appResult.app, resourceUri: '' } } });
  await invalidRun({ ...withApp, result: { ...appResult, flight: { bytes: -1, preview: 'flight', truncated: false } } });
  await expect(clientFor({ '/api/runtime/state/reset': { state: { stateStoreId: '', stateVersion: -1 } } }).resetState({ stateStoreId: 'state-a' }))
    .rejects.toMatchObject({ code: 'AB8206' });
  await expect(clientFor({ '/api/runtime/status': new Response(null, { status: 500 }) }).bootstrap()).rejects.toMatchObject({ code: 'AB8019' });
});
