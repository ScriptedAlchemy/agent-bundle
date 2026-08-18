import { expect, it } from '@rstest/core';

import type { PlaygroundTraceEvent } from '../../agent-bundle/src/services/playground-service.ts';
import { PlaygroundClient } from '../src/playground/playground-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';

interface RecordedRequest {
  readonly body: unknown;
  readonly method: string;
  readonly token: string | null;
  readonly url: string;
}

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const ndjson = (chunks: readonly string[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  },
}), { headers: { 'content-type': 'application/x-ndjson' }, status: 200 });

const identity = {
  epoch: { digest: 'sha256-epoch', id: 'epoch-1' },
  fixture: { digest: 'sha256-fixture', id: 'fixture-1' },
  invocation: { intent: { operation: 'build' }, kind: 'whole-plugin' },
  target: { digest: 'sha256-claude', name: 'claude' },
  task: { id: 'task-1', text: 'Review the emitted bundle.' },
};

const session = { cleanupFailures: [], createdAt: '2026-08-14T10:00:00.000Z', id: 'session-1', identity, state: 'open' };

const event = (sequence: number, summary: string): PlaygroundTraceEvent => ({
  kind: 'build.completed',
  raw: { sequence },
  rawEventRef: `session-1/${sequence}`,
  sequence,
  source: 'build',
  summary,
  timestamp: `2026-08-14T10:00:0${sequence}.000Z`,
});

const recordingFetch = (calls: RecordedRequest[], reply: () => Response): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (url === '/api/project/session') return response({
      cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
      origin: 'http://127.0.0.1:5173',
      token: 'foreground-token',
    });
    calls.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get('x-agent-bundle-session'),
      url,
    });
    return reply();
  };

const foreground = (fetch: typeof globalThis.fetch): ForegroundRouteClient => new ForegroundRouteClient({ fetch });

it('opens a session bound to one epoch over the same foreground session', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({ foreground: foreground(recordingFetch(calls, () => response({ session }))) });

  await expect(client.openSession(identity)).resolves.toMatchObject({ id: 'session-1', state: 'open' });
  expect(calls).toEqual([{
    body: identity,
    method: 'POST',
    token: 'foreground-token',
    url: '/api/playground/sessions',
  }]);
});

it('reads, closes, and reopens one session by its encoded id', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({ closed: true, session }))),
  });

  await client.session('session/1');
  await client.closeSession('session/1');
  await client.reopen('session/1');

  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    'GET /api/playground/sessions/session%2F1',
    'DELETE /api/playground/sessions/session%2F1',
    'POST /api/playground/sessions/session%2F1/reopen',
  ]);
  expect(calls[2]?.body).toEqual({});
});

it('appends one trace event and returns its sequence and raw event reference', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({ event: event(1, 'Build completed.') }))),
  });

  await expect(client.append('session-1', {
    kind: 'build.completed',
    raw: { sequence: 1 },
    source: 'build',
    summary: 'Build completed.',
  })).resolves.toMatchObject({ rawEventRef: 'session-1/1', sequence: 1 });
  expect(calls[0]?.url).toBe('/api/playground/sessions/session-1/events');
  expect(calls[0]?.body).toEqual({
    kind: 'build.completed',
    raw: { sequence: 1 },
    source: 'build',
    summary: 'Build completed.',
  });
});

it('finalizes a durable outcome onto the session', async () => {
  const calls: RecordedRequest[] = [];
  const finalized = { ...session, outcome: { response: 'Done', status: 'succeeded' }, state: 'finalized' };
  const client = new PlaygroundClient({ foreground: foreground(recordingFetch(calls, () => response({ session: finalized }))) });

  await expect(client.finalize('session-1', { response: 'Done', status: 'succeeded' }))
    .resolves.toMatchObject({ outcome: { status: 'succeeded' }, state: 'finalized' });
  expect(calls[0]?.url).toBe('/api/playground/sessions/session-1/finalize');
  expect(calls[0]?.body).toEqual({ response: 'Done', status: 'succeeded' });
});

it('replays from a cursor and preserves order and epoch binding', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({
      replay: { cursor: { afterSequence: 3 }, events: [event(2, 'Second.'), event(3, 'Third.')], session },
    }))),
  });

  const replay = await client.replay('session-1', 1);

  expect(calls[0]?.url).toBe('/api/playground/sessions/session-1/replay?after=1');
  expect(replay.events.map((entry) => entry.sequence)).toEqual([2, 3]);
  expect(replay.session.identity.epoch).toEqual(identity.epoch);
  expect(Object.isFrozen(replay)).toBe(true);
});

it('omits an absent replay cursor from the query', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({ replay: { cursor: { afterSequence: 0 }, events: [], session } }))),
  });

  await client.replay('session-1');

  expect(calls[0]?.url).toBe('/api/playground/sessions/session-1/replay');
});

it('exports the trace with its explicit schema version', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({ export: { events: [event(1, 'First.')], schemaVersion: 1, session } }))),
  });

  await expect(client.export('session-1')).resolves.toMatchObject({ schemaVersion: 1 });
  expect(calls[0]?.url).toBe('/api/playground/sessions/session-1/export');
});

it('promotes selected assertions into a draft eval case', async () => {
  const calls: RecordedRequest[] = [];
  const assertions = [{ evidence: { rawEventRef: 'session-1/1' }, expectation: { summary: 'Build completed.' }, id: 'session-1/1', kind: 'trace-event' }];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({
      draftEvalCase: {
        assertions,
        epoch: identity.epoch,
        fixture: identity.fixture,
        invocation: identity.invocation,
        outcome: { status: 'succeeded' },
        schemaVersion: 1,
        target: identity.target,
        task: identity.task,
      },
    }))),
  });

  await expect(client.promoteToDraftEval('session-1', assertions)).resolves.toMatchObject({
    epoch: { id: 'epoch-1' },
    schemaVersion: 1,
  });
  expect(calls[0]?.url).toBe('/api/playground/sessions/session-1/draft-eval');
  expect(calls[0]?.body).toEqual({ assertions });
});

it('decodes ndjson trace frames split across transport chunks', async () => {
  const received: PlaygroundTraceEvent[] = [];
  const first = JSON.stringify(event(1, 'First.'));
  const second = JSON.stringify(event(2, 'Second.'));
  const half = Math.floor(second.length / 2);
  const client = new PlaygroundClient({
    foreground: foreground(async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      expect(url).toBe('/api/playground/sessions/session-1/stream?after=0');
      return ndjson([`${first}\n${second.slice(0, half)}`, `${second.slice(half)}\n`]);
    }),
  });

  const stream = client.stream('session-1', { afterSequence: 0, onEvent: (entry) => received.push(entry) });
  await stream.done;

  expect(received.map((entry) => entry.sequence)).toEqual([1, 2]);
  expect(received.map((entry) => entry.rawEventRef)).toEqual(['session-1/1', 'session-1/2']);
  expect(Object.isFrozen(received[0])).toBe(true);
});

it('ends a stream without delivering more events once it is closed', async () => {
  const received: PlaygroundTraceEvent[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      init?.signal?.throwIfAborted();
      return ndjson([`${JSON.stringify(event(1, 'First.'))}\n`]);
    }),
  });

  const stream = client.stream('session-1', { onEvent: (entry) => received.push(entry) });
  stream.close();
  await stream.done;

  expect(received).toEqual([]);
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch([], () => response({
      diagnostic: { code: 'AB8046', message: 'Playground session is already finalized.' },
    }, 409))),
  });

  await expect(client.append('session-1', { kind: 'build.completed', raw: {}, source: 'build', summary: 'Done.' }))
    .rejects.toMatchObject({ code: 'AB8046', message: 'Playground session is already finalized.' });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const client = new PlaygroundClient({ foreground: foreground(recordingFetch([], () => response({}, 503))) });

  await expect(client.session('session-1')).rejects.toMatchObject({
    code: 'AB8043',
    message: 'Playground request failed with HTTP 503.',
  });
});
