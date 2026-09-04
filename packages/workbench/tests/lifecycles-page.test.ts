import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type {
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayRequest,
} from '../src/lifecycles/lifecycle-client.ts';
import {
  LifecycleReplayView,
  LifecyclesPage,
  runLifecycleReplay,
} from '../src/lifecycles/lifecycles-page.tsx';
import { lifecyclesViewFor } from '../src/lifecycles/lifecycles-model.ts';

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
    diagnostics: [],
    event: 'tool/after',
    routeId: 'event:tool/after',
    routePath: 'src/events/tool/after.tsx',
    targets: [{
      fixture: { label: 'Claude PostToolUse', native: { hook_event_name: 'PostToolUse' } },
      hostContractRevision: 'claude-hooks@1',
      nativeEvent: 'PostToolUse',
      target: 'claude',
    }],
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
    sequence: 1,
  },
  document,
  events: [
    { document, sequence: 0, type: 'shell' },
    { boundaryId: 'route', error: { code: 'render.partial', message: 'One boundary failed.' }, sequence: 1, type: 'error' },
    { document, sequence: 2, type: 'complete' },
  ],
  nativeInput: { hook_event_name: 'PostToolUse' },
  nativeResponse: { hookSpecificOutput: { additionalContext: 'Recorded README.md' } },
  projectionDiagnostic: { code: 'projection.partial', message: 'Optional output was omitted.' },
  requestContext: {
    actor: { reason: 'not-provided', state: 'unavailable' },
    host: { source: 'receipt', state: 'available', value: { name: 'claude' } },
    invocation: {
      hostContractRevision: 'claude-hooks@1',
      kind: 'event',
      operationId: 'event:tool/after',
      surface: 'tool/after',
    },
    lineage: { reason: 'not-provided', state: 'unavailable' },
    session: { reason: 'not-provided', state: 'unavailable' },
    workspace: { source: 'receipt', state: 'available', value: { root: '/workspace' } },
  },
  source: 'fixture',
};

it('renders one honest correlated replay view around the shared Agent Document stage', () => {
  const markup = renderToStaticMarkup(createElement(LifecycleReplayView, {
    view: lifecyclesViewFor({
      list: listing,
      listState: 'ready',
      result: { replay },
      selectedKey: 'claude/event:tool/after',
    }),
  }));

  expect(markup).toContain('Fixture');
  expect(markup).toContain('Deterministic replay');
  expect(markup).toContain('not evidence that claude dispatched this event');
  expect(markup).toContain('Canonical identity');
  expect(markup).toContain('Request context');
  expect(markup).toContain('claude · receipt');
  expect(markup).toContain('Unavailable · not-provided');
  expect(markup).toContain('/workspace · receipt');
  expect(markup).toContain('Native input');
  expect(markup).toContain('Agent Document');
  expect(markup).toContain('Recorded README.md from claude.');
  expect(markup).toContain('Complete · #2 · success');
  expect(markup).toContain('Native response');
  expect(markup).toContain('hookSpecificOutput');
  expect(markup).toContain('projection.partial');
  expect(markup).toContain('render.partial');
});

it('states that no native response was produced', () => {
  const markup = renderToStaticMarkup(createElement(LifecycleReplayView, {
    view: lifecyclesViewFor({
      list: listing,
      listState: 'ready',
      result: { replay: { ...replay, nativeResponse: undefined } },
      selectedKey: undefined,
    }),
  }));

  expect(markup).toContain('This replay produced no native response.');
});

it('renders an honest loading state before lifecycle discovery completes', () => {
  const client = {
    list: async () => new Promise<LifecycleListResponse>(() => undefined),
    replay: async () => ({ replay }),
  };
  const markup = renderToStaticMarkup(createElement(LifecyclesPage, { client }));

  expect(markup).toContain('Loading semantic lifecycles');
  expect(markup).not.toContain('Run replay');
  expect(markup).not.toContain('<main');
});

it('passes the manifest binding, native receipt, source, and signal unchanged', async () => {
  const requests: LifecycleReplayRequest[] = [];
  const signal = new AbortController().signal;
  const client = {
    list: async () => listing,
    replay: async (request: LifecycleReplayRequest) => {
      requests.push(request);
      return { replay };
    },
  };
  const request: LifecycleReplayRequest = {
    binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
    native: { hook_event_name: 'PostToolUse' },
    source: 'observed',
  };

  await runLifecycleReplay(client, request, signal);

  expect(requests).toEqual([request]);
});
