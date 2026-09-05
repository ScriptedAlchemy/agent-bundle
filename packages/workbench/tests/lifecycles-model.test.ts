import { expect, it } from '@rstest/core';

import {
  canonicalRowsFor,
  lifecycleOptionKeyFor,
  lifecycleOptionsFor,
  lifecycleReplaySourceFor,
  lineageChainFor,
  payloadRowsFor,
  requestRowsFor,
  resultDiagnosticsFor,
} from '../src/lifecycles/lifecycles-model.ts';
import type {
  LifecycleListResponse,
  LifecycleReplay,
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

it('derives correlated replay identity, payload, context, lineage, and diagnostics', () => {
  expect(canonicalRowsFor(replay)).toEqual([
    { label: 'Canonical event', value: 'tool/after' },
    { label: 'Idempotency key', value: 'receipt-a' },
    { label: 'Observed at', value: '2026-09-01T12:00:00.000Z' },
    { label: 'Sequence', value: '7' },
    { label: 'Host', value: 'claude' },
    { label: 'Native event', value: 'PostToolUse' },
    { label: 'Host contract revision', value: 'claude-hooks@1' },
  ]);
  expect(payloadRowsFor(replay)).toEqual([
    { label: 'toolName', value: 'Write · tool_name' },
  ]);
  expect(requestRowsFor(replay)).toEqual([
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
  expect(resultDiagnosticsFor(replay)).toEqual([
    { code: 'projection.partial', message: 'Optional host field was omitted.', source: 'projection' },
    { code: 'render.partial', message: 'One boundary failed.', source: 'render stream' },
  ]);
  expect(lineageChainFor(replay)).toEqual([
    { id: 'session-1', role: 'current' },
  ]);
});
