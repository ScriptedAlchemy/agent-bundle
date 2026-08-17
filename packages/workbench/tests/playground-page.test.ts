import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type {
  PlaygroundSession,
  PlaygroundTraceEvent,
} from '../../agent-bundle/src/services/playground-service.ts';
import { PlaygroundClient } from '../src/playground/playground-client.ts';
import { playgroundViewFor } from '../src/playground/playground-model.ts';
import {
  PlaygroundPage,
  PlaygroundTraceView,
  exportPlaygroundTrace,
  finalizePlaygroundOutcome,
  openPlaygroundSession,
  promotePlaygroundDraftEval,
  replayPlaygroundTrace,
} from '../src/playground/playground-page.tsx';

const epoch = { digest: 'sha256-epoch', id: 'epoch-1' };

const identity = {
  epoch,
  fixture: { digest: 'sha256-fixture', id: 'fixture-1' },
  invocation: { intent: { operation: 'build' }, kind: 'whole-plugin' },
  target: { digest: 'sha256-claude', name: 'claude' },
  task: { id: 'task-1', text: 'Review the emitted bundle.' },
};

const session: PlaygroundSession = {
  cleanupFailures: [],
  createdAt: '2026-08-14T10:00:00.000Z',
  id: 'session-1',
  identity,
  state: 'open',
};

const finalized: PlaygroundSession = {
  ...session,
  outcome: { response: 'The bundle built cleanly.', status: 'succeeded' },
  state: 'finalized',
};

const event = (sequence: number): PlaygroundTraceEvent => ({
  kind: 'build.completed',
  raw: { position: sequence },
  rawEventRef: `session-1/${sequence}`,
  sequence,
  source: 'build',
  summary: `Recorded event ${sequence}`,
  timestamp: `2026-08-14T10:00:0${sequence}.000Z`,
});

const events: readonly PlaygroundTraceEvent[] = [event(1), event(2)];

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const stubFetch = (bodies: unknown[], reply: (url: string) => Response): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : url);
    return reply(url);
  };

it('renders every trace row with its sequence, source, kind, epoch, and raw event reference', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: ['session-1/1'], session }),
  }));

  expect(markup).toContain('session-1/1');
  expect(markup).toContain('session-1/2');
  expect(markup).toContain('epoch-1');
  expect(markup).toContain('build.completed');
  expect(markup).toContain('Recorded event 2');
  expect(markup).toContain('2026-08-14T10:00:01.000Z');
});

it('states why promotion is refused while the session is still open', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: [], session }),
  }));

  expect(markup).toContain('Finalize a durable outcome');
});

it('renders no session controls and no request state when no epoch is active', () => {
  const client = new PlaygroundClient({ fetch: async () => { throw new Error('No epoch may issue a playground request.'); } });
  const markup = renderToStaticMarkup(createElement(PlaygroundPage, { client, epoch: undefined, onSessionChange: () => undefined, session: undefined, targets: [] }));

  expect(markup).toContain('No artifact epoch is active');
  expect(markup).not.toContain('id="playground-task-text"');
  expect(markup).not.toContain('Open session');
});

it('offers session identity controls without any natural-language host action', () => {
  const client = new PlaygroundClient({ fetch: async () => response({ session }) });
  const markup = renderToStaticMarkup(createElement(PlaygroundPage, {
    client,
    epoch,
    onSessionChange: () => undefined,
    session: undefined,
    targets: [{ digest: 'sha256-claude', name: 'claude' }],
  }));

  expect(markup).toContain('id="playground-fixture-id"');
  expect(markup).toContain('id="playground-task-text"');
  expect(markup).toContain('id="playground-invocation-kind"');
  expect(markup).toContain('Open session');
  expect(markup.toLowerCase()).not.toContain('prompt');
  expect(markup.toLowerCase()).not.toContain('send to model');
});

it('opens a session bound to the active epoch', async () => {
  const bodies: unknown[] = [];
  const client = new PlaygroundClient({ fetch: stubFetch(bodies, () => response({ session })) });

  await expect(openPlaygroundSession(client, identity)).resolves.toMatchObject({ id: 'session-1' });
  expect(bodies).toEqual([identity]);
});

it('replays from a cursor and preserves ordering and epoch binding', async () => {
  const urls: unknown[] = [];
  const client = new PlaygroundClient({
    fetch: stubFetch(urls, () => response({
      replay: { cursor: { afterSequence: 2 }, events: [event(2), event(1)], session },
    })),
  });

  const replay = await replayPlaygroundTrace(client, 'session-1', 1);

  expect(urls).toEqual(['/api/playground/sessions/session-1/replay?after=1']);
  expect(replay.events.map((entry) => entry.sequence)).toEqual([2, 1]);
  expect(replay.session.identity.epoch).toEqual(epoch);
});

it('finalizes a durable outcome and exports the trace with its schema version', async () => {
  const bodies: unknown[] = [];
  const client = new PlaygroundClient({
    fetch: stubFetch(bodies, (url) => url.endsWith('/finalize')
      ? response({ session: finalized })
      : response({ export: { events, schemaVersion: 1, session: finalized } })),
  });

  await expect(finalizePlaygroundOutcome(client, 'session-1', { response: 'Done', status: 'succeeded' }))
    .resolves.toMatchObject({ state: 'finalized' });
  await expect(exportPlaygroundTrace(client, 'session-1')).resolves.toMatchObject({ schemaVersion: 1 });
  expect(bodies[0]).toEqual({ response: 'Done', status: 'succeeded' });
});

it('surfaces the route refusal when promotion runs before a durable outcome exists', async () => {
  const client = new PlaygroundClient({
    fetch: stubFetch([], () => response({
      diagnostic: { code: 'AB8052', message: 'A durable playground outcome is required first.' },
    }, 400)),
  });

  await expect(promotePlaygroundDraftEval(client, 'session-1', [{
    evidence: { rawEventRef: 'session-1/1' },
    expectation: { summary: 'Recorded event 1' },
    id: 'session-1/1',
    kind: 'trace-event',
  }])).rejects.toMatchObject({ code: 'AB8052' });
});
