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

/** Mirrors the server-issued per-listener foreground session bootstrap. */
const foregroundSession = Object.freeze({
  cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
  origin: 'http://localhost',
  token: 'token',
});

const clientFor = (routes: Readonly<Record<string, unknown>>): RuntimeClient => new RuntimeClient(new ForegroundRouteClient({
  fetch: async (input) => {
    const url = String(input);
    if (url === '/api/project/session') return Response.json(foregroundSession);
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

it('queues one latest selected-fixture run only after a same-provider generation activation bootstraps', () => {
  const initial = model();
  const activation = reduce(initial, {
    event: event(1, 'runtime.generation.activated', undefined, 'provider-a', 'generation-b'),
    type: 'event.received',
  });
  const activated = reduce(activation, {
    bootstrap: bootstrap({ status: status({ activeVector: vector({ runtimeGenerationId: 'generation-b' }), lastGoodVector: vector({ runtimeGenerationId: 'generation-b' }) }) }),
    type: 'bootstrap.received',
  });
  const completed = reduce(activated, {
    run: run('run-activation', { vector: vector({ runtimeGenerationId: 'generation-b' }) }),
    type: 'run.received',
  });

  expect(effectFor(activation)).toMatchObject({ kind: 'bootstrap', triggerSequence: 1 });
  expect(effectFor(activated)).toMatchObject({
    cause: 'activation',
    kind: 'create-run',
    request: { expectedGenerationId: 'generation-b', fixtureId: 'fixture-a', input: { city: 'London' }, surfaceId: 'weather', target: 'portable' },
  });
  expect(effectFor(completed)).toBeUndefined();

  const settledFor = (eventInput: ProjectEventMessage, nextBootstrap: RuntimeBootstrap): RuntimeModel => {
    const pending = reduce(initial, { event: eventInput, type: 'event.received' });
    return reduce(pending, { bootstrap: nextBootstrap, type: 'bootstrap.received' });
  };
  const nextGeneration = bootstrap({ status: status({ activeVector: vector({ runtimeGenerationId: 'generation-b' }), lastGoodVector: vector({ runtimeGenerationId: 'generation-b' }) }) });
  const providerBVector = vector({ providerSessionId: 'provider-b', runtimeGenerationId: 'generation-b' });
  const providerRestart = bootstrap({
    history: [run('run-provider-b', { vector: providerBVector })],
    providerSessionId: 'provider-b',
    status: status({ activeVector: providerBVector, lastGoodVector: providerBVector }),
  });
  const manual = reduce(initial, { type: 'run.request' }, { type: 'confirmation.confirm' });
  const conflicted = reduce(manual, { id: effectFor(manual)!.id, type: 'effect.conflict' });

  expect(effectFor(createRuntimeModel({ bootstrap: nextGeneration, profiles }))).toBeUndefined();
  expect(effectFor(settledFor(event(1, 'runtime.status', undefined, 'provider-a', 'generation-b'), nextGeneration))).toBeUndefined();
  expect(effectFor(settledFor(event(1, 'runtime.generation.failed', undefined, 'provider-a', 'generation-b'), nextGeneration))).toBeUndefined();
  expect(effectFor(reduce(initial, { event: event(1, 'runtime.hmr.client-connected', { connectionCount: 1, surfaceId: 'weather' }), type: 'event.received' }))).toBeUndefined();
  expect(effectFor(settledFor(event(1, 'runtime.generation.activated', undefined, 'provider-b', 'generation-b'), providerRestart))).toBeUndefined();
  expect(effectFor(reduce(conflicted, { bootstrap: nextGeneration, type: 'bootstrap.received' }))).toBeUndefined();
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

it('rejects a stale provider run injected into a fresh-provider bootstrap', () => {
  const freshProviderSessionId = 'provider-fresh';
  const freshVector = vector({
    providerSessionId: freshProviderSessionId,
    runtimeGenerationId: 'generation-fresh',
    stateStoreId: 'state-fresh',
  });

  expect(() => createRuntimeModel({
    bootstrap: bootstrap({
      history: [run('stale-provider-a-run')],
      providerSessionId: freshProviderSessionId,
      status: status({ activeVector: freshVector, lastGoodVector: freshVector }),
    }),
    profiles,
  })).toThrow(/provider session/i);
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
  const bootstrappedRoutes = {
    '/api/runtime/runs?limit=50': { providerSessionId: 'provider-a', runs: [run('initial')] },
    '/api/runtime/status': { status: status() },
    '/api/runtime/surfaces': { surfaces: [surface()] },
  };
  const opaqueClient = clientFor({ ...bootstrappedRoutes, '/api/runtime/runs/..': { run: run('x') } });
  await opaqueClient.bootstrap();
  await expect(opaqueClient.readRun('..')).rejects.toMatchObject({ code: 'AB8206' });
  const assetClient = clientFor({
    ...bootstrappedRoutes,
    '/api/runtime/assets/weather/assets/main.js?generation=generation-a': new Response(new Uint8Array([1]), {
      headers: { 'content-length': '-1', 'content-type': 'application/javascript' },
    }),
  });
  await assetClient.bootstrap();
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
    flight: { bytes: 8, downloadPath: '/api/runtime/runs/app-evidence/flight', preview: 'flight', truncated: false },
  };
  const withApp = {
    ...original,
    result: appResult,
  } satisfies DevRuntimeRun;
  const appClient = clientFor({
    '/api/runtime/runs?limit=50': { providerSessionId: 'provider-a', runs: [run('initial')] },
    '/api/runtime/status': { status: status() },
    '/api/runtime/surfaces': { surfaces: [surface()] },
    '/api/runtime/runs': { run: withApp },
  });
  await appClient.bootstrap();
  await expect(appClient.createRun({ input: {}, surfaceId: 'weather', target: 'portable' }))
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
    const client = clientFor({
      '/api/runtime/runs?limit=50': { providerSessionId: 'provider-a', runs: [run('initial')] },
      '/api/runtime/status': { status: status() },
      '/api/runtime/surfaces': { surfaces: [surface()] },
      '/api/runtime/runs': { run: entry },
    });
    await client.bootstrap();
    await expect(client.createRun({ input: {}, surfaceId: 'weather', target: 'portable' })).rejects.toMatchObject({ code: 'AB8206' });
  };
  await invalidRun({ ...run('bad-run'), status: 'unknown' });
  await invalidRun({ ...withApp, result: { ...appResult, tree: [{ children: [], id: '', kind: 'component', label: 'bad' }] } });
  await invalidRun({ ...withApp, result: { ...appResult, trace: [{ id: 'trace', phase: 'rsc', startedAt: 'no-date', status: 'succeeded' }] } });
  await invalidRun({ ...withApp, result: { ...appResult, app: { ...appResult.app, resourceUri: '' } } });
  await invalidRun({ ...withApp, result: { ...appResult, flight: { bytes: -1, preview: 'flight', truncated: false } } });
  const invalidStateClient = clientFor({
    '/api/runtime/runs?limit=50': { providerSessionId: 'provider-a', runs: [run('initial')] },
    '/api/runtime/status': { status: status() },
    '/api/runtime/surfaces': { surfaces: [surface()] },
    '/api/runtime/state/reset': { state: { stateStoreId: '', stateVersion: -1 } },
  });
  await invalidStateClient.bootstrap();
  await expect(invalidStateClient.resetState({ stateStoreId: 'state-a' }))
    .rejects.toMatchObject({ code: 'AB8206' });
  await expect(clientFor({ '/api/runtime/status': new Response(null, { status: 500 }) }).bootstrap()).rejects.toMatchObject({ code: 'AB8019' });
});

it('monotonically replaces a same-ID running run with its terminal record and rejects incompatible identity', () => {
  const running = {
    ...run('evolving'),
    completedAt: undefined,
    result: undefined,
    status: 'running',
  } as DevRuntimeRun;
  const state = model({ history: [running] });
  const completed = reduce(state, { run: run('evolving'), type: 'run.received' });

  expect(completed.history).toHaveLength(1);
  expect(completed.history[0]?.status).toBe('succeeded');
  expect(completed.lastGoodRunId).toBe('evolving');
  expect(() => reduce(completed, {
    run: run('evolving', { startedAt: '2026-08-15T12:00:02.000Z' }),
    type: 'run.received',
  })).toThrow(/run ID/i);
  expect(() => reduce(completed, {
    run: run('evolving', { vector: vector({ runtimeGenerationId: 'generation-b' }) }),
    type: 'run.received',
  })).toThrow(/run ID/i);
});

it('falls selection back only when bounded history evicts it', () => {
  const history = Array.from({ length: 50 }, (_, index) => run(`run-${index}`, {
    startedAt: `2026-08-15T12:00:${String(index).padStart(2, '0')}.000Z`,
  }));
  const initial = reduce(model({ history }), { runId: 'run-0', type: 'selection.run' });
  const evicted = reduce(initial, { run: run('run-new', { startedAt: '2026-08-15T12:01:00.000Z' }), type: 'run.received' });
  const preserved = reduce(reduce(model({ history }), { runId: 'run-40', type: 'selection.run' }), {
    run: run('run-new', { startedAt: '2026-08-15T12:01:00.000Z' }),
    type: 'run.received',
  });

  expect(evicted.history).toHaveLength(50);
  expect(evicted.history.some((entry) => entry.id === 'run-0')).toBe(false);
  expect(evicted.selectedRunId).toBe('run-new');
  expect(preserved.selectedRunId).toBe('run-40');
});

it('deduplicates an identical replay gap but advances recovery for a newer dropped range', () => {
  const firstGap = { earliestAvailableSequence: 6, latestDroppedSequence: 5, requestedAfterSequence: 1, type: 'replay.gap' } as const;
  const newerGap = { earliestAvailableSequence: 9, latestDroppedSequence: 8, requestedAfterSequence: 5, type: 'replay.gap' } as const;
  const first = reduce(model(), { event: firstGap, type: 'event.received' });
  const duplicate = reduce(first, { event: firstGap, type: 'event.received' });
  const newer = reduce(duplicate, { event: newerGap, type: 'event.received' });

  expect(duplicate).toBe(first);
  expect(newer.replayGap).toEqual(newerGap);
  expect(newer.replayDroppedThroughSequence).toBe(8);
  expect(newer.activeEffect).toMatchObject({ kind: 'bootstrap', triggerSequence: 5 });
  expect(newer.pendingEffect).toMatchObject({ kind: 'bootstrap', triggerSequence: 8 });
});

it('coalesces background read overflow to history bootstrap without losing confirmed run or reset requests', () => {
  const activeRead = reduce(model(), { event: {
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: { providerSessionId: 'provider-a', runId: 'run-a', runtimeGenerationId: 'generation-a', type: 'runtime.run.completed' },
    sequence: 1,
    type: 'runtime.event',
  }, type: 'event.received' });
  const full = reduce(activeRead, { event: event(2, 'runtime.generation.activated'), type: 'event.received' });
  const overflow = reduce(full, { event: {
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: { providerSessionId: 'provider-a', runId: 'run-b', runtimeGenerationId: 'generation-a', type: 'runtime.run.completed' },
    sequence: 3,
    type: 'runtime.event',
  }, type: 'event.received' });
  const runConfirmed = reduce(overflow, { type: 'run.request' }, { type: 'confirmation.confirm' });
  const resetConfirmed = reduce(overflow, { type: 'reset.request' }, { type: 'confirmation.confirm' });
  const activeRunRead = runConfirmed.activeEffect;
  const activeResetRead = resetConfirmed.activeEffect;
  if (activeRunRead === undefined || activeResetRead === undefined) throw new Error('Expected active background reads.');
  const readSettledForRun = reduce(runConfirmed, { id: activeRunRead.id, type: 'effect.settled' });
  const readSettledForReset = reduce(resetConfirmed, { id: activeResetRead.id, type: 'effect.settled' });
  const runQueued = reduce(readSettledForRun, { type: 'confirmation.confirm' });
  const resetQueued = reduce(readSettledForReset, { type: 'confirmation.confirm' });

  expect(overflow.activeEffect).toMatchObject({ kind: 'read-run', runId: 'run-a' });
  expect(overflow.pendingEffect).toMatchObject({ kind: 'bootstrap', triggerSequence: 2 });
  expect(overflow.historyBootstrapPending).toBe(true);
  expect(runConfirmed.confirmation).toMatchObject({ kind: 'run' });
  expect(resetConfirmed.confirmation).toMatchObject({ kind: 'reset' });
  expect(runQueued.confirmation).toBeUndefined();
  expect(runQueued.pendingEffect).toMatchObject({ kind: 'create-run' });
  expect(resetQueued.confirmation).toBeUndefined();
  expect(resetQueued.pendingEffect).toMatchObject({ kind: 'reset-state' });
});

it('clears malformed HMR evidence by named surface or globally while ignoring lower sequences', () => {
  const connected = reduce(model(), { event: event(4, 'runtime.hmr.client-connected', { connectionCount: 2, surfaceId: 'weather' }), type: 'event.received' });
  const malformedNamed = reduce(connected, { event: event(5, 'runtime.hmr.client-disconnected', { connectionCount: 'bad', surfaceId: 'weather' }), type: 'event.received' });
  const twoKnown = reduce(malformedNamed,
    { event: event(6, 'runtime.hmr.client-connected', { connectionCount: 1, surfaceId: 'weather' }), type: 'event.received' },
    { event: event(7, 'runtime.hmr.client-connected', { connectionCount: 1, surfaceId: 'other' }), type: 'event.received' },
  );
  const malformedGlobal = reduce(twoKnown, { event: event(8, 'runtime.hmr.client-disconnected', { connectionCount: 0 }), type: 'event.received' });
  const lower = reduce(twoKnown, { event: event(7, 'runtime.hmr.client-disconnected', { connectionCount: 'bad', surfaceId: 'weather' }), type: 'event.received' });

  expect(malformedNamed.hmrClientCountBySurface.weather).toBeUndefined();
  expect(malformedNamed.hmrClientCountKnownSurfaces).toEqual([]);
  expect(malformedGlobal.hmrClientCountKnownSurfaces).toEqual([]);
  expect(lower).toBe(twoKnown);
});

it('admits terminal state-version progress only for stable same-run evidence', () => {
  const input = { city: 'London', filters: ['today'] } as const;
  const running = {
    ...run('evolving-terminal', { input }),
    completedAt: undefined,
    result: undefined,
    status: 'running',
  } as DevRuntimeRun;
  const succeeded = run('evolving-terminal', { input, vector: vector({ stateVersion: 2 }) });
  if (succeeded.status !== 'succeeded') throw new Error('Expected succeeded terminal fixture.');
  const terminal = {
    ...succeeded,
    result: {
      ...succeeded.result,
      state: {
        ...succeeded.result.state,
        identity: { ...succeeded.result.state.identity, stateVersion: 2 },
      },
    },
  } satisfies DevRuntimeRun;
  const state = model({ history: [running] });
  const merged = reduce(state, { run: terminal, type: 'run.received' });

  expect(merged.history[0]?.vector.stateVersion).toBe(2);
  expect(() => reduce(state, {
    run: { ...terminal, input: { city: 'Paris', filters: ['today'] } },
    type: 'run.received',
  })).toThrow(/run ID/i);
  expect(() => reduce(state, {
    run: { ...terminal, vector: vector({ runtimeGenerationId: 'generation-b', stateVersion: 2 }) },
    type: 'run.received',
  })).toThrow(/run ID/i);
  expect(() => reduce(state, {
    run: { ...terminal, startedAt: '2026-08-15T12:00:02.000Z' },
    type: 'run.received',
  })).toThrow(/run ID/i);
  expect(() => reduce(state, {
    run: {
      ...terminal,
      result: {
        ...terminal.result,
        state: { ...terminal.result.state, identity: { stateStoreId: 'state-a', stateVersion: 1 } },
      },
    },
    type: 'run.received',
  })).toThrow(/terminal result state/i);
});

it('never applies runtime events at or below the replay-gap recovery watermark', () => {
  const gap = { earliestAvailableSequence: 9, latestDroppedSequence: 8, requestedAfterSequence: 1, type: 'replay.gap' } as const;
  const recovered = reduce(model(), { event: gap, type: 'event.received' });
  const stale = reduce(recovered, {
    event: event(7, 'runtime.hmr.client-connected', { connectionCount: 2, surfaceId: 'weather' }),
    type: 'event.received',
  });
  const next = reduce(stale, {
    event: event(9, 'runtime.hmr.client-connected', { connectionCount: 3, surfaceId: 'weather' }),
    type: 'event.received',
  });

  expect(stale).toBe(recovered);
  expect(next.lastConsumedEventSequence).toBe(9);
  expect(next.hmrClientCountBySurface.weather).toBe(3);
});

it('preserves one direct read-only or replay operation through a full effect queue', () => {
  const queuedBase = (): RuntimeModel => reduce(model({
    history: [run('run-old', { vector: vector({ runtimeGenerationId: 'generation-old' }) })],
    status: status({ activeVector: vector({ runtimeGenerationId: 'generation-new' }) }),
    surfaces: [surface({ readOnly: true })],
  }), {
    event: {
      occurredAt: '2026-08-15T12:00:00.000Z',
      payload: { providerSessionId: 'provider-a', runId: 'run-a', runtimeGenerationId: 'generation-new', type: 'runtime.run.completed' },
      sequence: 1,
      type: 'runtime.event',
    },
    type: 'event.received',
  }, { event: event(2, 'runtime.generation.activated', undefined, 'provider-a', 'generation-new'), type: 'event.received' });
  const promoteExactlyOnce = (state: RuntimeModel): RuntimeModel => {
    const read = effectFor(state);
    if (read === undefined) throw new Error('Expected an active read effect.');
    const afterRead = reduce(state, { id: read.id, type: 'effect.settled' });
    const bootstrap = effectFor(afterRead);
    if (bootstrap === undefined) throw new Error('Expected an active bootstrap effect.');
    const afterBootstrap = reduce(afterRead, { id: bootstrap.id, type: 'effect.settled' });
    const deferred = effectFor(afterBootstrap);
    if (deferred === undefined) throw new Error('Expected the deferred foreground effect.');
    const drained = reduce(afterBootstrap, { id: deferred.id, type: 'effect.settled' });
    expect(drained.activeEffect).toBeUndefined();
    expect(drained.pendingEffect).toBeUndefined();
    return afterBootstrap;
  };

  const direct = reduce(queuedBase(), { type: 'run.request' });
  const exact = reduce(queuedBase(), { mode: 'exact', runId: 'run-old', type: 'replay.request' });
  const latest = reduce(queuedBase(), { mode: 'latest', runId: 'run-old', type: 'replay.request' });

  expect(direct.deferredOperation).toMatchObject({ cause: 'manual', kind: 'create-run', request: { surfaceId: 'weather', target: 'portable' } });
  expect(exact.deferredOperation).toMatchObject({ kind: 'replay-run', request: { expectedGenerationId: 'generation-old', mode: 'exact', runId: 'run-old' } });
  expect(latest.deferredOperation).toMatchObject({ kind: 'replay-run', mode: 'latest', runId: 'run-old' });
  expect(promoteExactlyOnce(direct).activeEffect).toMatchObject({ cause: 'manual', kind: 'create-run' });
  expect(promoteExactlyOnce(exact).activeEffect).toMatchObject({ kind: 'replay-run', request: { mode: 'exact', runId: 'run-old' } });
  expect(promoteExactlyOnce(latest).activeEffect).toMatchObject({ kind: 'replay-run', request: { mode: 'latest', runId: 'run-old' } });
});

it('rebinds deferred latest intents after activation while retaining exact replay generation', () => {
  const oldGeneration = 'generation-old';
  const newGeneration = 'generation-new';
  const activatedBootstrap = bootstrap({
    history: [run('run-old', { vector: vector({ runtimeGenerationId: oldGeneration }) })],
    status: status({
      activeVector: vector({ runtimeGenerationId: newGeneration }),
      lastGoodVector: vector({ runtimeGenerationId: newGeneration }),
    }),
    surfaces: [surface({ readOnly: true })],
  });
  const fullQueue = (): RuntimeModel => reduce(model({
    history: [run('run-old', { vector: vector({ runtimeGenerationId: oldGeneration }) })],
    status: status({
      activeVector: vector({ runtimeGenerationId: oldGeneration }),
      lastGoodVector: vector({ runtimeGenerationId: oldGeneration }),
    }),
    surfaces: [surface({ readOnly: true })],
  }), {
    event: {
      occurredAt: '2026-08-15T12:00:00.000Z',
      payload: { providerSessionId: 'provider-a', runId: 'run-a', runtimeGenerationId: oldGeneration, type: 'runtime.run.completed' },
      sequence: 1,
      type: 'runtime.event',
    },
    type: 'event.received',
  }, { event: event(2, 'runtime.generation.activated', undefined, 'provider-a', newGeneration), type: 'event.received' });
  const promoteAfterActivation = (state: RuntimeModel) => {
    const read = effectFor(state);
    if (read === undefined) throw new Error('Expected active read effect.');
    const bootstrapping = reduce(state, { id: read.id, type: 'effect.settled' });
    const bootstrapEffect = effectFor(bootstrapping);
    if (bootstrapEffect === undefined || bootstrapEffect.kind !== 'bootstrap') throw new Error('Expected active bootstrap effect.');
    const activated = reduce(bootstrapping, { bootstrap: activatedBootstrap, type: 'bootstrap.received' });
    const promoted = effectFor(activated);
    if (promoted === undefined) throw new Error('Expected promoted foreground effect.');
    const drained = reduce(activated, { id: promoted.id, type: 'effect.settled' });
    const activationReplay = effectFor(drained);
    expect(activationReplay).toMatchObject({ cause: 'activation', kind: 'create-run', request: { expectedGenerationId: newGeneration } });
    const settled = reduce(drained, { id: activationReplay!.id, type: 'effect.settled' });
    expect(effectFor(settled)).toBeUndefined();
    expect(settled.pendingEffect).toBeUndefined();
    return promoted;
  };

  const direct = promoteAfterActivation(reduce(fullQueue(), { type: 'run.request' }));
  const latest = promoteAfterActivation(reduce(fullQueue(), { mode: 'latest', runId: 'run-old', type: 'replay.request' }));
  const exact = promoteAfterActivation(reduce(fullQueue(), { mode: 'exact', runId: 'run-old', type: 'replay.request' }));

  expect(direct).toMatchObject({ cause: 'manual', kind: 'create-run', request: { expectedGenerationId: newGeneration } });
  expect(latest).toMatchObject({ kind: 'replay-run', request: { expectedGenerationId: newGeneration, mode: 'latest', runId: 'run-old' } });
  expect(exact).toMatchObject({ kind: 'replay-run', request: { expectedGenerationId: oldGeneration, mode: 'exact', runId: 'run-old' } });
  if (exact.kind !== 'replay-run') throw new Error('Expected exact replay effect.');
  expect(Object.isFrozen(exact.request)).toBe(true);
});

it('retains an activation replay through a later refresh bootstrap without duplicating it', () => {
  const generationB = 'generation-b';
  const generationBBootstrap = bootstrap({
    status: status({
      activeVector: vector({ runtimeGenerationId: generationB }),
      lastGoodVector: vector({ runtimeGenerationId: generationB }),
    }),
  });
  const foreground = reduce(model(), { type: 'run.request' }, { type: 'confirmation.confirm' });
  const activated = reduce(foreground, {
    event: event(2, 'runtime.generation.activated', undefined, 'provider-a', generationB),
    type: 'event.received',
  });
  const refreshed = reduce(activated, {
    event: event(3, 'runtime.status', undefined, 'provider-a', generationB),
    type: 'event.received',
  });
  const activeForeground = effectFor(refreshed);
  if (activeForeground === undefined || activeForeground.kind !== 'create-run') throw new Error('Expected active foreground run.');
  const booting = reduce(refreshed, { id: activeForeground.id, type: 'effect.settled' });
  const activeBootstrap = effectFor(booting);
  if (activeBootstrap === undefined || activeBootstrap.kind !== 'bootstrap') throw new Error('Expected coalesced bootstrap.');
  const replayed = reduce(booting, { bootstrap: generationBBootstrap, type: 'bootstrap.received' });
  const activationRun = effectFor(replayed);
  if (activationRun === undefined) throw new Error('Expected selected-fixture activation run.');
  const settled = reduce(replayed, { id: activationRun.id, type: 'effect.settled' });
  const laterBootstrap = reduce(settled, { bootstrap: generationBBootstrap, type: 'bootstrap.received' });

  expect(activeBootstrap.triggerSequence).toBe(3);
  expect(activationRun).toMatchObject({
    cause: 'activation',
    kind: 'create-run',
    request: { expectedGenerationId: generationB, fixtureId: 'fixture-a', input: { city: 'London' }, surfaceId: 'weather', target: 'portable' },
  });
  expect(replayed.pendingActivationReplay).toBeUndefined();
  expect(effectFor(settled)).toBeUndefined();
  expect(effectFor(laterBootstrap)).toBeUndefined();
  expect(laterBootstrap.pendingActivationReplay).toBeUndefined();
});

it('does not retain or auto-run activation replay for same, foreign, conflicted, or unavailable bootstraps', () => {
  const generationB = 'generation-b';
  const generationBBootstrap = bootstrap({
    status: status({
      activeVector: vector({ runtimeGenerationId: generationB }),
      lastGoodVector: vector({ runtimeGenerationId: generationB }),
    }),
  });
  const activate = (providerSessionId = 'provider-a', runtimeGenerationId = generationB): RuntimeModel => reduce(model(), {
    event: event(1, 'runtime.generation.activated', undefined, providerSessionId, runtimeGenerationId),
    type: 'event.received',
  });
  const sameGeneration = reduce(activate('provider-a', 'generation-a'), {
    bootstrap: bootstrap(),
    type: 'bootstrap.received',
  });
  const foreign = reduce(activate('provider-b'), {
    bootstrap: bootstrap({
      history: [run('provider-b', { vector: vector({ providerSessionId: 'provider-b', runtimeGenerationId: generationB }) })],
      providerSessionId: 'provider-b',
      status: status({
        activeVector: vector({ providerSessionId: 'provider-b', runtimeGenerationId: generationB }),
        lastGoodVector: vector({ providerSessionId: 'provider-b', runtimeGenerationId: generationB }),
      }),
    }),
    type: 'bootstrap.received',
  });
  const activation = activate();
  const activeBootstrap = effectFor(activation);
  if (activeBootstrap === undefined || activeBootstrap.kind !== 'bootstrap') throw new Error('Expected activation bootstrap.');
  const conflicted = reduce(activation, { id: activeBootstrap.id, type: 'effect.conflict' });
  const afterConflict = reduce(conflicted, { bootstrap: generationBBootstrap, type: 'bootstrap.received' });
  const unavailable = reduce(activate(), { bootstrap: { kind: 'unavailable' }, type: 'bootstrap.received' });

  for (const state of [sameGeneration, foreign, afterConflict, unavailable]) {
    expect(effectFor(state)).toBeUndefined();
    expect(state.pendingActivationReplay).toBeUndefined();
  }
  expect(effectFor(conflicted)).toMatchObject({ kind: 'bootstrap' });
  expect(conflicted.pendingActivationReplay).toBeUndefined();
});

it('retains activation replay through replay-gap recovery without duplicating it later', () => {
  const generationB = 'generation-b';
  const gap = { earliestAvailableSequence: 4, latestDroppedSequence: 3, requestedAfterSequence: 1, type: 'replay.gap' } as const;
  const generationBBootstrap = bootstrap({
    status: status({
      activeVector: vector({ runtimeGenerationId: generationB }),
      lastGoodVector: vector({ runtimeGenerationId: generationB }),
    }),
  });
  const foreground = reduce(model(), { type: 'run.request' }, { type: 'confirmation.confirm' });
  const activated = reduce(foreground, {
    event: event(2, 'runtime.generation.activated', undefined, 'provider-a', generationB),
    type: 'event.received',
  });
  const recovered = reduce(activated, { event: gap, type: 'event.received' });
  const activeForeground = effectFor(recovered);
  if (activeForeground === undefined || activeForeground.kind !== 'create-run') throw new Error('Expected active foreground run.');
  const booting = reduce(recovered, { id: activeForeground.id, type: 'effect.settled' });
  const activeBootstrap = effectFor(booting);
  if (activeBootstrap === undefined || activeBootstrap.kind !== 'bootstrap') throw new Error('Expected replay-gap bootstrap.');
  const replayed = reduce(booting, { bootstrap: generationBBootstrap, type: 'bootstrap.received' });
  const activationRun = effectFor(replayed);
  if (activationRun === undefined) throw new Error('Expected selected-fixture activation run.');
  const settled = reduce(replayed, { id: activationRun.id, type: 'effect.settled' });
  const laterBootstrap = reduce(settled, { bootstrap: generationBBootstrap, type: 'bootstrap.received' });

  expect(recovered.replayGap).toEqual(gap);
  expect(recovered.replayDroppedThroughSequence).toBe(3);
  expect(activeBootstrap.triggerSequence).toBe(3);
  expect(activationRun).toMatchObject({
    cause: 'activation',
    kind: 'create-run',
    request: { expectedGenerationId: generationB, fixtureId: 'fixture-a', input: { city: 'London' }, surfaceId: 'weather', target: 'portable' },
  });
  expect(replayed.pendingActivationReplay).toBeUndefined();
  expect(effectFor(settled)).toBeUndefined();
  expect(effectFor(laterBootstrap)).toBeUndefined();
  expect(laterBootstrap.pendingActivationReplay).toBeUndefined();
});
