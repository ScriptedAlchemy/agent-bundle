import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from '@rstest/core';

import type { PlaygroundSession, PlaygroundTraceEvent } from '../../agent-bundle/src/services/playground-service.ts';
import { PlaygroundClient } from '../src/playground/playground-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { playgroundViewFor } from '../src/playground/playground-model.ts';
import { PlaygroundPage, PlaygroundTraceView } from '../src/playground/playground-page.tsx';

const epoch = { digest: 'sha256-current', id: 'epoch-current' };
const identity = {
  epoch: { digest: 'sha256-pinned', id: 'epoch-pinned' }, fixture: { digest: 'server', id: 'server-owned-workspace' },
  invocation: { intent: { skillId: 'review' }, kind: 'skill.inspect' }, target: { digest: 'portable', name: 'portable' },
  task: { id: 'run-1', text: 'Inspect an emitted Skill.' },
};
const session: PlaygroundSession = { cleanupFailures: [], createdAt: '2026-08-14T10:00:00.000Z', id: 'session-1', identity, state: 'open' };
const event = (sequence: number): PlaygroundTraceEvent => ({
  kind: sequence === 1 ? 'epoch.bound' : 'skill.inspected', raw: { sequence }, rawEventRef: `events.jsonl#${sequence}`,
  sequence, source: sequence === 1 ? 'build' : 'skill-evidence', summary: `Event ${sequence}`, timestamp: `2026-08-14T10:00:0${sequence}.000Z`,
});

const events: readonly PlaygroundTraceEvent[] = [event(1), event(2)];

const foreground = (fetch: typeof globalThis.fetch): ForegroundRouteClient => new ForegroundRouteClient({ fetch });

it('renders every trace row with its sequence, source, kind, epoch, and raw event reference', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: ['session-1/1'], session }),
  }));

  expect(markup).toContain('events.jsonl#1');
  expect(markup).toContain('events.jsonl#2');
  expect(markup).toContain('epoch-pinned');
  expect(markup).toContain('skill.inspected');
  expect(markup).toContain('Event 2');
  expect(markup).toContain('2026-08-14T10:00:01.000Z');
});

it('renders only typed server-owned operation drafts and a visibly unavailable script capability', () => {
  const client = new PlaygroundClient({ foreground: foreground(async () => { throw new Error('Static rendering issues no request.'); }) });
  const markup = renderToStaticMarkup(createElement(PlaygroundPage, {
    client, epoch, onRunChange: () => undefined, run: undefined, targets: [{ digest: 'portable', name: 'portable' }],
  }));

  expect(markup).toContain('Start run');
  expect(markup).toContain('Skill inspection');
  expect(markup).toContain('Hook simulation');
  expect(markup).toContain('MCP tool call');
  expect(markup).toContain('Script execution is unavailable');
  for (const forbidden of ['playground-fixture', 'playground-task', 'playground-invocation', 'playground-outcome', 'playground-epoch']) {
    expect(markup).not.toContain(forbidden);
  }
});

it('renders the pinned server epoch and persisted event references, not a rebuilt current epoch', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events: [event(1), event(2)], exported: undefined, selectedRefs: ['events.jsonl#2'], session }),
  }));
  expect(markup).toContain('epoch-pinned');
  expect(markup).toContain('events.jsonl#2');
  expect(markup).not.toContain('epoch-current');
});
