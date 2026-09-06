import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { RouteInvocationSummary } from '../../agent-bundle/src/contracts/invocations.ts';
import type { ApplicationLeaf, ApplicationTree } from '../src/application/application-tree-model.ts';
import type { InvocationBackend } from '../src/application/invocation-backend.ts';
import {
  loadTraceHistory,
  mergeTraceEntries,
  sortTraceEntries,
  traceDurationMs,
  traceEntryLocation,
  TracePage,
} from '../src/trace/trace-page.tsx';

const summary = (id: string, completedAt: string, overrides: Partial<RouteInvocationSummary> = {}): RouteInvocationSummary => ({
  completedAt,
  diagnostics: [],
  id,
  input: {},
  kind: 'tool',
  manifestDigest: 'a'.repeat(64),
  outcome: { kind: 'success' },
  routeId: 'tool:curator/search_audible',
  source: 'src/mcp/curator/tools/search_audible.tsx',
  sourceRevision: 'r',
  startedAt: '2026-09-05T07:00:00.000Z',
  status: 'succeeded',
  surface: { kind: 'mcp' },
  timings: [{ durationMs: 12, phase: 'handler', startedAt: '2026-09-05T07:00:00.000Z' }],
  ...overrides,
});

const leaf = (routeId: string, execution: ApplicationLeaf['execution'] = 'invoke'): ApplicationLeaf => ({
  config: [],
  execution,
  key: routeId,
  label: routeId,
  ref: { kind: 'script', name: routeId },
  routeId,
});

const tree: ApplicationTree = {
  diagnostics: [],
  groups: [
    { key: 'scripts', kind: 'scripts', label: 'Scripts', leaves: [leaf('script:sync'), leaf('script:report')] },
    { key: 'skills', kind: 'skills', label: 'Skills', leaves: [leaf('skill:review', 'document')] },
  ],
  leafCount: 3,
  state: 'fresh',
};

const backend = (kind: InvocationBackend['kind'], history: (leaf: ApplicationLeaf) => Promise<readonly RouteInvocationSummary[]>, accepts: (leaf: ApplicationLeaf) => boolean = () => true): InvocationBackend & { readonly asked: string[] } => {
  const asked: string[] = [];
  return {
    accepts,
    asked,
    history: (target) => { asked.push(target.key); return history(target); },
    invoke: () => Promise.reject(new Error('not under test')),
    kind,
    read: () => Promise.reject(new Error('not under test')),
    subscribe: () => () => undefined,
  };
};

it('sorts newest first and merges by id with the later summary winning', () => {
  const older = summary('a', '2026-09-05T07:00:01.000Z');
  const newer = summary('b', '2026-09-05T07:00:05.000Z');
  const updated = summary('a', '2026-09-05T07:00:09.000Z', { status: 'failed' });
  expect(sortTraceEntries([older, newer]).map((entry) => entry.id)).toEqual(['b', 'a']);
  const merged = mergeTraceEntries([older, newer], [updated]);
  expect(merged.map((entry) => [entry.id, entry.status])).toEqual([['a', 'failed'], ['b', 'succeeded']]);
  expect(Object.isFrozen(merged)).toBe(true);
});

it('measures duration from the envelope clock and falls back to phase timings', () => {
  expect(traceDurationMs(summary('a', '2026-09-05T07:00:00.250Z'))).toBe(250);
  expect(traceDurationMs(summary('a', 'not-a-date'))).toBe(12);
});

it('deep-links an entry to its route workspace with the invocation loaded', () => {
  expect(traceEntryLocation(summary('inv-1', '2026-09-05T07:00:01.000Z'))).toEqual({
    area: 'application',
    invocationId: 'inv-1',
    node: { kind: 'tool', name: 'search_audible', server: 'curator' },
  });
  expect(traceEntryLocation(summary('inv-1', '2026-09-05T07:00:01.000Z', { routeId: 'nonsense' }))).toBeUndefined();
});

it('loads history only for invocable leaves the backend accepts, dedupes across backends, and reports one failure', async () => {
  const shared = summary('shared', '2026-09-05T07:00:01.000Z', { routeId: 'script:sync' });
  const devServer = backend('dev-server', async (target) => target.routeId === 'script:sync' ? [shared, summary('dev-only', '2026-09-05T07:00:02.000Z')] : []);
  const runtime = backend('runtime', async (target) => {
    if (target.routeId === 'script:report') throw new Error('runtime history offline');
    return [shared];
  }, (target) => target.routeId !== 'skill:review');
  const history = await loadTraceHistory([runtime, devServer], tree);
  expect(devServer.asked).toEqual(['script:sync', 'script:report']);
  expect(runtime.asked).toEqual(['script:sync', 'script:report']);
  expect(history.entries.map((entry) => entry.id)).toEqual(['dev-only', 'shared']);
  expect(history.error).toBe('runtime history offline');
});

it('renders the table shell in its loading state and the single-entry heading', () => {
  const idle = backend('dev-server', async () => []);
  const list = renderToStaticMarkup(createElement(TracePage, { backends: [idle], onNavigate: () => undefined, tree }));
  expect(list).toContain('<h1>Trace</h1>');
  expect(list).toContain('loading history…');
  expect(list).toContain('data-testid="trace-empty"');

  const one = renderToStaticMarkup(createElement(TracePage, { backends: [idle], invocationId: 'inv-9', onNavigate: () => undefined, tree }));
  expect(one).toContain('One invocation.');
  expect(one).toContain('href="/trace"');
  expect(one).toContain('Loading invocation inv-9…');
});
