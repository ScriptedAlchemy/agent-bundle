import { afterEach, beforeEach, expect, it } from '@rstest/core';

import type { RouteInvocation } from '../../agent-bundle/src/contracts/invocations.ts';
import type { ApplicationLeaf } from '../src/application/application-tree-model.ts';
import type { InvocationBackend } from '../src/application/invocation-backend.ts';
import {
  idleInvocationState,
  invocationSummaryOf,
  readLastInput,
  reduceInvocationState,
  selectBackend,
  writeLastInput,
} from '../src/application/invocation-model.ts';

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
    routeId: invocation.routeId,
    source: invocation.source,
    sourceRevision: invocation.sourceRevision,
    startedAt: invocation.startedAt,
    status: invocation.status,
    surface: { kind: 'mcp' },
    timings: [],
  });
});
