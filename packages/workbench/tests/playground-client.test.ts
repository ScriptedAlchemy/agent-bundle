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
  fixture: { digest: 'sha256-fixture', id: 'server-owned-workspace' },
  invocation: { intent: { skillId: 'review' }, kind: 'skill.inspect' },
  target: { digest: 'sha256-portable', name: 'portable' },
  task: { id: 'task-1', text: 'Inspect an emitted Skill.' },
};

const session = { cleanupFailures: [], createdAt: '2026-08-14T10:00:00.000Z', id: 'session-1', identity, state: 'open' } as const;

const event = (sequence: number, summary: string): PlaygroundTraceEvent => ({
  kind: sequence === 1 ? 'epoch.bound' : 'skill.inspected',
  raw: { sequence },
  rawEventRef: `events.jsonl#${sequence}`,
  sequence,
  source: sequence === 1 ? 'build' : 'skill-evidence',
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

it('starts one server-owned skill inspection over the shared foreground session', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({ run: { id: 'run-1', session } }))),
  });

  await expect(client.run({ operation: 'skill.inspect', skillId: 'review', target: 'portable' }))
    .resolves.toMatchObject({ id: 'run-1', session: { id: 'session-1' } });

  expect(calls).toEqual([{
    body: { operation: 'skill.inspect', skillId: 'review', target: 'portable' },
    method: 'POST',
    token: 'foreground-token',
    url: '/api/playground/runs',
  }]);
});

it('starts only the exact hook and MCP operation shapes that the server accepts', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({ run: { id: 'run-1', session } }))),
  });

  await client.run({ hook: 'beforeTool', input: { tool: 'read' }, operation: 'hook.simulate', target: 'portable' });
  await client.run({ arguments: { city: 'Berlin' }, operation: 'mcp.call-tool', serverName: 'weather', target: 'portable', tool: 'forecast' });

  expect(calls.map((call) => call.body)).toEqual([
    { hook: 'beforeTool', input: { tool: 'read' }, operation: 'hook.simulate', target: 'portable' },
    { arguments: { city: 'Berlin' }, operation: 'mcp.call-tool', serverName: 'weather', target: 'portable', tool: 'forecast' },
  ]);
});

it('cancels a run then reads its server-owned session by encoded identity', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({ foreground: foreground(recordingFetch(calls, () => response(calls.length === 1 ? { cancelled: true } : { session }))) });

  await expect(client.cancel('run/1')).resolves.toBe(true);
  await client.session('session/1');

  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    'POST /api/playground/runs/run%2F1/cancel',
    'GET /api/playground/sessions/session%2F1',
  ]);
  expect(calls[0]?.body).toEqual({});
});

it('replays, exports, and promotes persisted raw event references only', async () => {
  const calls: RecordedRequest[] = [];
  const terminal = { ...session, outcome: { status: 'passed' }, state: 'finalized' } as const;
  const client = new PlaygroundClient({
    foreground: foreground(recordingFetch(calls, () => response({
      draftEvalCase: {
        assertions: [], epoch: identity.epoch, fixture: identity.fixture, invocation: identity.invocation,
        outcome: { status: 'passed' }, schemaVersion: 1, target: identity.target, task: identity.task,
      },
      export: { events: [event(1, 'Bound.')], schemaVersion: 1, session: terminal },
      replay: { cursor: { afterSequence: 2 }, events: [event(1, 'Bound.'), event(2, 'Inspected.')], session: terminal },
    }))),
  });

  await client.replay('session-1', 1);
  await client.export('session-1');
  await client.promoteToDraftEval('session-1', ['events.jsonl#1', 'events.jsonl#2']);

  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    'GET /api/playground/sessions/session-1/replay?after=1',
    'GET /api/playground/sessions/session-1/export',
    'POST /api/playground/sessions/session-1/draft-eval',
  ]);
  expect(calls[2]?.body).toEqual({ rawEventRefs: ['events.jsonl#1', 'events.jsonl#2'] });
});

it('decodes NDJSON trace frames split across transport chunks', async () => {
  const received: PlaygroundTraceEvent[] = [];
  const first = JSON.stringify(event(1, 'Bound.'));
  const second = JSON.stringify(event(2, 'Inspected.'));
  const half = Math.floor(second.length / 2);
  const client = new PlaygroundClient({
    foreground: foreground(async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      expect(url).toBe('/api/playground/sessions/session-1/stream?after=1');
      return ndjson([`${first}\n${second.slice(0, half)}`, `${second.slice(half)}\n`]);
    }),
  });

  const stream = client.stream('session-1', { afterSequence: 1, onEvent: (entry) => received.push(entry) });
  await stream.done;

  expect(received.map((entry) => entry.rawEventRef)).toEqual(['events.jsonl#1', 'events.jsonl#2']);
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

  await expect(client.session('session-1'))
    .rejects.toMatchObject({ code: 'AB8046', message: 'Playground session is already finalized.' });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const client = new PlaygroundClient({ foreground: foreground(recordingFetch([], () => response({}, 503))) });

  await expect(client.session('session-1')).rejects.toMatchObject({
    code: 'AB8043',
    message: 'Playground request failed with HTTP 503.',
  });
});
