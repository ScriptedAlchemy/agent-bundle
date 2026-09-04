import { expect, it } from '@rstest/core';

import {
  lifecycleOptionKeyFor,
  lifecycleOptionsFor,
  lifecycleReplaySourceFor,
  lifecyclesViewFor,
} from '../src/lifecycles/lifecycles-model.ts';
import type {
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayResult,
} from '../src/lifecycles/lifecycle-client.ts';

const document = {
  root: {
    children: [{ kind: 'context' as const, text: 'Recorded README.md from claude.' }],
    kind: 'result' as const,
  },
  status: 'success' as const,
  version: 1 as const,
};

const listing: LifecycleListResponse = {
  lifecycles: [{
    diagnostics: [{
      code: 'lifecycle.target.unsupported',
      message: 'Portable cannot project tool/after.',
      severity: 'error',
      target: 'portable',
    }],
    event: 'tool/after',
    routeId: 'event:tool/after',
    routePath: 'src/events/tool/after.tsx',
    targets: [
      {
        fixture: { label: 'Codex tool completion', native: { cwd: '/workspace', type: 'tool-complete' } },
        hostContractRevision: 'codex-events@2',
        nativeEvent: 'tool-complete',
        target: 'codex',
      },
      {
        fixture: { label: 'Claude PostToolUse', native: { cwd: '/workspace', hook_event_name: 'PostToolUse' } },
        hostContractRevision: 'claude-hooks@1',
        nativeEvent: 'PostToolUse',
        target: 'claude',
      },
    ],
  }],
  manifestDigest: 'manifest-a',
};

const replay: LifecycleReplay = {
  binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
  canonical: {
    event: 'tool/after',
    idempotencyKey: 'receipt-a',
    observedAt: '2026-09-01T12:00:00.000Z',
    payload: { toolName: { nativeKey: 'tool_name', value: 'Write' } },
    provenance: {
      host: 'claude',
      hostContractRevision: 'claude-hooks@1',
      nativeEvent: 'PostToolUse',
      source: 'native',
    },
    sequence: 7,
  },
  document,
  events: [
    { document, sequence: 0, type: 'shell' },
    { boundaryId: 'route', error: { code: 'render.partial', message: 'One boundary failed.' }, sequence: 1, type: 'error' },
    { document, sequence: 2, type: 'complete' },
  ],
  nativeInput: { hook_event_name: 'PostToolUse' },
  projectionDiagnostic: { code: 'projection.partial', message: 'Optional host field was omitted.' },
  requestContext: {
    actor: { reason: 'not-provided', state: 'unavailable' },
    host: { source: 'receipt', state: 'available', value: { name: 'claude' } },
    invocation: {
      hostContractRevision: 'claude-hooks@1',
      kind: 'event',
      operationId: 'event:tool/after',
      surface: 'tool/after',
    },
    lineage: { source: 'receipt', state: 'available', value: { conversation: 'session-1', depth: 0, resolution: 'native', root: 'session-1' } },
    session: { source: 'receipt', state: 'available', value: { sessionId: 'session-1' } },
    workspace: { source: 'receipt', state: 'available', value: { root: '/workspace' } },
  },
  source: 'fixture',
};

it('flattens event route targets into deterministic lifecycle options', () => {
  const options = lifecycleOptionsFor(listing);

  expect(options.map((option) => option.key)).toEqual([
    'claude/event:tool/after',
    'codex/event:tool/after',
  ]);
  expect(options.map((option) => option.label)).toEqual([
    'tool/after · claude',
    'tool/after · codex',
  ]);
  expect(options[0]).toMatchObject({
    binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
    fixture: { label: 'Claude PostToolUse' },
    nativeEvent: 'PostToolUse',
    routePath: 'src/events/tool/after.tsx',
  });
  expect(Object.isFrozen(options)).toBe(true);
  expect(lifecycleOptionKeyFor('event:tool/after', 'claude')).toBe('claude/event:tool/after');
});

it('downgrades edited fixture input to observed provenance', () => {
  expect(lifecycleReplaySourceFor('fixture', false)).toBe('fixture');
  expect(lifecycleReplaySourceFor('fixture', true)).toBe('observed');
  expect(lifecycleReplaySourceFor('observed', false)).toBe('observed');
  expect(lifecycleReplaySourceFor('observed', true)).toBe('observed');
});

it('derives one correlated replay view with identity, context, and diagnostics', () => {
  const view = lifecyclesViewFor({
    list: listing,
    listState: 'ready',
    result: { replay },
    selectedKey: 'claude/event:tool/after',
  });

  expect(view.state).toBe('replayed');
  expect(view.selected?.nativeEvent).toBe('PostToolUse');
  expect(view.replay).toEqual(replay);
  expect(view.canonicalRows).toEqual([
    { label: 'Canonical event', value: 'tool/after' },
    { label: 'Idempotency key', value: 'receipt-a' },
    { label: 'Observed at', value: '2026-09-01T12:00:00.000Z' },
    { label: 'Sequence', value: '7' },
    { label: 'Host', value: 'claude' },
    { label: 'Native event', value: 'PostToolUse' },
    { label: 'Host contract revision', value: 'claude-hooks@1' },
  ]);
  // The canonical payload shows each mapped field beside the host key it came from (#466).
  expect(view.payloadRows).toEqual([
    { label: 'toolName', value: 'Write · tool_name' },
  ]);
  expect(view.requestRows).toEqual([
    { label: 'Invocation kind', value: 'event' },
    { label: 'Operation ID', value: 'event:tool/after' },
    { label: 'Surface', value: 'tool/after' },
    { label: 'Host contract revision', value: 'claude-hooks@1' },
    { label: 'Host', value: 'claude · receipt' },
    { label: 'Session', value: 'session-1 · receipt' },
    { label: 'Actor', value: 'Unavailable · not-provided' },
    { label: 'Workspace', value: '/workspace · receipt' },
    { label: 'Lineage', value: 'session-1 · depth 0 · native · receipt' },
  ]);
  expect(view.resultDiagnostics).toEqual([
    { code: 'projection.partial', message: 'Optional host field was omitted.', source: 'projection' },
    { code: 'render.partial', message: 'One boundary failed.', source: 'render stream' },
  ]);
  expect(view.listDiagnostics).toEqual(listing.lifecycles[0]!.diagnostics);
  expect(Object.isFrozen(view)).toBe(true);
});

it('keeps an unsupported replay result distinct from list diagnostics', () => {
  const result: LifecycleReplayResult = {
    diagnostics: [{
      code: 'lifecycle.target.unsupported',
      event: 'tool/after',
      message: 'Portable cannot project tool/after.',
      severity: 'error',
      target: 'portable',
    }],
  };
  const view = lifecyclesViewFor({ list: listing, listState: 'ready', result, selectedKey: undefined });

  expect(view.state).toBe('diagnostics');
  expect(view.replay).toBeUndefined();
  expect(view.replayDiagnostics).toEqual(result.diagnostics);
});

it('does not silently rebind an explicit selection missing from a refreshed manifest', () => {
  const view = lifecyclesViewFor({
    list: listing,
    listState: 'ready',
    result: undefined,
    selectedKey: 'claude/event:removed',
  });

  expect(view.selected).toBeUndefined();
  expect(view.state).toBe('ready');
});

it('distinguishes loading, list failure, empty, ready, and replayed states', () => {
  expect(lifecyclesViewFor({ list: undefined, listState: 'loading', result: undefined, selectedKey: undefined }).state).toBe('loading');
  expect(lifecyclesViewFor({ list: undefined, listState: 'error', result: undefined, selectedKey: undefined }).state).toBe('list-error');
  expect(lifecyclesViewFor({
    list: { lifecycles: [], manifestDigest: 'manifest-a' },
    listState: 'ready',
    result: undefined,
    selectedKey: undefined,
  }).state).toBe('empty');
  expect(lifecyclesViewFor({ list: listing, listState: 'ready', result: undefined, selectedKey: undefined }).state).toBe('ready');
  expect(lifecyclesViewFor({ list: listing, listState: 'ready', result: { replay }, selectedKey: undefined }).state).toBe('replayed');
});

it('returns detached frozen data and rejects response accessors without invoking them', () => {
  const mutable = structuredClone(listing) as LifecycleListResponse;
  const view = lifecyclesViewFor({ list: mutable, listState: 'ready', result: { replay }, selectedKey: undefined });
  (mutable.lifecycles[0]!.targets[0]!.fixture!.native as Record<string, unknown>).cwd = '/changed';

  expect(view.selected?.fixture?.native).toEqual({ cwd: '/workspace', hook_event_name: 'PostToolUse' });
  expect(Object.isFrozen(view.selected?.fixture?.native)).toBe(true);
  expect(view.replay).not.toBe(replay);

  let reads = 0;
  const hostile = { ...listing } as LifecycleListResponse;
  Object.defineProperty(hostile, 'manifestDigest', {
    enumerable: true,
    get: () => {
      reads += 1;
      return 'manifest-a';
    },
  });
  expect(() => lifecyclesViewFor({ list: hostile, listState: 'ready', result: undefined, selectedKey: undefined })).toThrow('accessors');
  expect(reads).toBe(0);
});
