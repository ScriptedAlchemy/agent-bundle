import { afterEach, beforeEach, expect, it } from '@rstest/core';

import {
  emptyRetainedRenderEvents,
  retainedRenderEvents,
  routeInvocationRenderHistoryLimits,
  type RouteInvocation,
} from '../../agent-bundle/src/contracts/invocations.ts';
import type { ApplicationLeaf } from '../src/application/application-tree-model.ts';
import type { InvocationBackend } from '../src/application/invocation-backend.ts';
import {
  idleInvocationState,
  invocationSummaryOf,
  outcomeLabel,
  readLastInput,
  reduceInvocationState,
  selectBackend,
  statusLabel,
  writeLastInput,
  type InvocationState,
} from '../src/application/invocation-model.ts';
import { foldAgentDocumentEvents } from '../src/application/rendered-document.tsx';
import type { AgentRenderEvent } from '../src/runtime/agent-document-client.ts';

const invocation = Object.freeze({
  completedAt: '2026-09-05T07:00:01.000Z',
  context: Object.freeze({
    actor: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    host: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    invocation: Object.freeze({ kind: 'workbench' as const }),
    lineage: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    session: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    workspace: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
  }),
  diagnostics: Object.freeze([]),
  events: Object.freeze([]),
  id: 'invocation-a',
  input: Object.freeze({ title: 'Dune' }),
  kind: 'tool' as const,
  manifestDigest: 'manifest-a',
  outcome: Object.freeze({ kind: 'success' as const }),
  projection: Object.freeze({}),
  providers: Object.freeze([]),
  routeId: 'tool:curator/search_audible',
  source: 'src/search.tsx',
  sourceRevision: 'source-a',
  startedAt: '2026-09-05T07:00:00.000Z',
  status: 'succeeded' as const,
  surface: Object.freeze({ kind: 'mcp' as const }),
  timings: Object.freeze([]),
}) satisfies RouteInvocation;

const leaf = Object.freeze({
  config: Object.freeze([]),
  execution: 'invoke' as const,
  key: '/routes/mcp/curator/tool/search_audible',
  label: 'Search Audible',
  ref: Object.freeze({ kind: 'tool' as const, name: 'search_audible', server: 'curator' }),
  routeId: invocation.routeId,
}) satisfies ApplicationLeaf;

const backend = (kind: InvocationBackend['kind'], accepts: boolean): InvocationBackend => ({
  accepts: () => accepts,
  history: async () => [],
  invoke: async () => invocation,
  kind,
  read: async () => invocation,
  subscribe: () => () => undefined,
});

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    } satisfies Storage,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'sessionStorage');
});

it('reduces invocation lifecycle states without retaining stale failures', () => {
  const running = reduceInvocationState(idleInvocationState, { correlationId: 'c1', startedAt: 1_000, type: 'start' });
  expect(running).toEqual({ correlationId: 'c1', phase: 'running', startedAt: 1_000 });
  expect(reduceInvocationState(running, { completedAt: 1_250, invocation, type: 'settle' })).toEqual({
    durationMs: 250,
    invocation,
    phase: 'succeeded',
  });
  expect(reduceInvocationState(running, {
    completedAt: 1_100,
    failure: { code: 'AB8237', message: 'render failed' },
    type: 'fail',
  })).toEqual({ diagnostics: [], durationMs: 100, failure: { code: 'AB8237', message: 'render failed' }, phase: 'failed' });
  expect(reduceInvocationState(idleInvocationState, { invocation, type: 'load' })).toEqual({ invocation, phase: 'succeeded' });
  expect(reduceInvocationState(running, { type: 'reset' })).toBe(idleInvocationState);
});

const liveEvents = (state: InvocationState): readonly AgentRenderEvent[] => {
  if (state.phase !== 'running') throw new Error('Expected a running invocation.');
  return retainedRenderEvents(state.history ?? emptyRetainedRenderEvents);
};

it('retains only the newest 256 live render events', () => {
  let state = reduceInvocationState(idleInvocationState, { correlationId: 'c1', startedAt: 1_000, type: 'start' });
  for (let sequence = 0; sequence < 300; sequence += 1) {
    state = reduceInvocationState(state, {
      event: {
        document: { root: { kind: 'text', text: 'rendering' }, status: 'success', version: 1 },
        sequence,
        type: 'shell',
      },
      type: 'render',
    });
  }

  expect(state).toMatchObject({ phase: 'running' });
  const events = liveEvents(state);
  expect(events).toHaveLength(256);
  expect(events[0]?.sequence).toBe(44);
  expect(events.at(-1)?.sequence).toBe(299);
  if (state.phase !== 'running') throw new Error('Expected a running invocation.');
  expect(state.history).toMatchObject({ evictedEvents: 44, producedEvents: 300 });
});

it('pins the latest document event while a long progress sequence evicts the rest', () => {
  const shell = {
    document: { root: { kind: 'text' as const, text: 'shell' }, status: 'success' as const, version: 1 as const },
    sequence: 0,
    type: 'shell' as const,
  };
  let state = reduceInvocationState(idleInvocationState, { correlationId: 'c1', startedAt: 1_000, type: 'start' });
  state = reduceInvocationState(state, { event: shell, type: 'render' });
  for (let sequence = 1; sequence <= 400; sequence += 1) {
    state = reduceInvocationState(state, { event: { completed: sequence, sequence, total: 400, type: 'progress' }, type: 'render' });
  }

  const events = liveEvents(state);
  expect(events).toHaveLength(routeInvocationRenderHistoryLimits.maxEvents);
  expect(events[0]).toEqual(shell);
  expect(events[1]?.sequence).toBe(146);
  expect(events.at(-1)?.sequence).toBe(400);
  expect(foldAgentDocumentEvents(events)).toMatchObject({
    complete: false,
    document: shell.document,
    progress: { completed: 400 },
  });
});

it('bounds the live window by retained bytes, not only by event count', () => {
  const snapshot = (sequence: number) => ({
    boundaryId: 'b',
    document: { root: { kind: 'text' as const, text: 'x'.repeat(256 * 1024) }, status: 'success' as const, version: 1 as const },
    sequence,
    type: 'replace' as const,
  });
  let state = reduceInvocationState(idleInvocationState, { correlationId: 'c1', startedAt: 1_000, type: 'start' });
  for (let sequence = 0; sequence < 24; sequence += 1) {
    state = reduceInvocationState(state, { event: snapshot(sequence), type: 'render' });
  }

  if (state.phase !== 'running') throw new Error('Expected a running invocation.');
  expect(state.history?.retainedBytes).toBeLessThanOrEqual(routeInvocationRenderHistoryLimits.maxBytes);
  expect(state.history?.evictedEvents).toBe(17);
  expect(liveEvents(state).map((event) => event.sequence)).toEqual([17, 18, 19, 20, 21, 22, 23]);
});

it('stores strict JSON last-input snapshots by leaf key and tolerates unavailable storage', () => {
  writeLastInput(leaf.key, { regions: ['us'], title: 'Dune' });
  expect(readLastInput(leaf.key)).toEqual({ regions: ['us'], title: 'Dune' });
  globalThis.sessionStorage.setItem(`agent-bundle:invocation-input:${leaf.key}`, '{"title":NaN}');
  expect(readLastInput(leaf.key)).toBeUndefined();
  expect(() => writeLastInput(leaf.key, { nested: { fn: undefined } } as never)).not.toThrow();
});

it('selects the first accepting backend and creates exact summaries', () => {
  const selected = selectBackend([
    backend('runtime', false),
    backend('dev-server', true),
    backend('runtime', true),
  ], leaf);

  expect(selected?.kind).toBe('dev-server');
  expect(invocationSummaryOf(invocation)).toEqual({
    completedAt: invocation.completedAt,
    diagnostics: [],
    id: invocation.id,
    input: invocation.input,
    kind: invocation.kind,
    manifestDigest: invocation.manifestDigest,
    outcome: { kind: 'success' },
    routeId: invocation.routeId,
    source: invocation.source,
    sourceRevision: invocation.sourceRevision,
    startedAt: invocation.startedAt,
    status: invocation.status,
    surface: { kind: 'mcp' },
    timings: [],
  });
});

it('labels execution status and outcome as distinct facts', () => {
  expect(statusLabel('succeeded')).toBe('Completed');
  expect(statusLabel('failed')).toBe('Failed');
  expect(outcomeLabel({ kind: 'success' })).toBe('Success');
  expect(outcomeLabel({ kind: 'represented-error', summary: '[refused] Refused: policy' }))
    .toBe('Represented error · [refused] Refused: policy');
  expect(outcomeLabel({ exitCode: 3, kind: 'process-exit' })).toBe('Exit code 3');
});
