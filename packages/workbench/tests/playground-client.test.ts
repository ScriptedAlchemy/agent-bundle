import { expect, it } from '@rstest/core';

import type { PlaygroundTraceEvent } from '../../agent-bundle/src/services/playground-service.ts';
import { PlaygroundClient } from '../src/playground/playground-client.ts';

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

/** Supplies adversarial decoded JSON values that a real JSON parser cannot produce. */
const decodedResponse = (body: unknown): Response => ({
  json: async () => body,
  ok: true,
  status: 200,
} as unknown as Response);

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

const nativeCatalog = {
  cases: [{ id: 'case:review', label: 'Review the fixture' }],
  epochId: 'epoch/native',
  fixtures: [{ id: 'fixture:clean', label: 'Clean workspace' }],
  modelPins: [{ host: 'claude', id: 'pin:claude-sonnet', label: 'Claude Sonnet (authored pin)' }],
  selections: [{ caseId: 'case:review', fixtureId: 'fixture:clean', host: 'claude', modelPinId: 'pin:claude-sonnet' }],
} as const;

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
    if (url === '/api/project/session') return response({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
    calls.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get('x-agent-bundle-session'),
      url,
    });
    return reply();
  };

const hostileFetch = (body: unknown): typeof fetch => async (input) =>
  String(input) === '/api/project/session'
    ? response({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:5173', token: 'foreground-token' })
    : decodedResponse(body);

it('starts one server-owned skill inspection without browser-authored identity or evidence', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({ fetch: recordingFetch(calls, () => response({ run: { id: 'run-1', session } })) });

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
  const client = new PlaygroundClient({ fetch: recordingFetch(calls, () => response({ run: { id: 'run-1', session } })) });

  await client.run({ hook: 'beforeTool', input: { tool: 'read' }, operation: 'hook.simulate', target: 'portable' });
  await client.run({ arguments: { city: 'Berlin' }, operation: 'mcp.call-tool', serverName: 'weather', target: 'portable', tool: 'forecast' });

  expect(calls.map((call) => call.body)).toEqual([
    { hook: 'beforeTool', input: { tool: 'read' }, operation: 'hook.simulate', target: 'portable' },
    { arguments: { city: 'Berlin' }, operation: 'mcp.call-tool', serverName: 'weather', target: 'portable', tool: 'forecast' },
  ]);
});

it('loads a detached exact native catalog for the requested epoch through the authenticated foreground lifecycle', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({ fetch: recordingFetch(calls, () => response({ catalog: nativeCatalog })) });

  const catalog = await client.catalog('epoch/native');

  expect(calls).toEqual([{
    body: undefined,
    method: 'GET',
    token: 'foreground-token',
    url: '/api/playground/catalog?epochId=epoch%2Fnative',
  }]);
  expect(catalog).toEqual(nativeCatalog);
  expect(Object.isFrozen(catalog)).toBe(true);
  expect(Object.isFrozen(catalog.selections[0])).toBe(true);
});

it('forwards catalog cancellation through the authenticated foreground transport', async () => {
  const controller = new AbortController();
  let catalogSignal: AbortSignal | null | undefined;
  const client = new PlaygroundClient({
    fetch: async (input, init) => {
      if (String(input) === '/api/project/session') return response({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      expect(String(input)).toBe('/api/playground/catalog?epochId=epoch%2Fnative');
      catalogSignal = init?.signal;
      return response({ catalog: nativeCatalog });
    },
  });

  await expect(client.catalog('epoch/native', controller.signal)).resolves.toEqual(nativeCatalog);
  expect(catalogSignal).toBe(controller.signal);
});

it('sends an exact native prompt admission body without arbitrary browser execution fields', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({ fetch: recordingFetch(calls, () => response({ run: { id: 'run-1', session } })) });

  await client.run({
    caseId: 'case:review', epochId: 'epoch-native', fixtureId: 'fixture:clean', host: 'claude', modelPinId: 'pin:claude-sonnet',
    operation: 'native.prompt', prompt: 'Review the fixture.', target: 'claude',
  });

  expect(calls[0]?.body).toEqual({
    caseId: 'case:review', epochId: 'epoch-native', fixtureId: 'fixture:clean', host: 'claude', modelPinId: 'pin:claude-sonnet',
    operation: 'native.prompt', prompt: 'Review the fixture.', target: 'claude',
  });
  expect(Object.keys(calls[0]?.body as object).sort()).toEqual([
    'caseId', 'epochId', 'fixtureId', 'host', 'modelPinId', 'operation', 'prompt', 'target',
  ]);
});

it('rejects malformed native catalogs, catalog tuple incoherence, and an epoch response that does not match the request', async () => {
  const malformed: readonly unknown[] = [
    { catalog: { ...nativeCatalog, epochId: 'other-epoch' } },
    { catalog: { ...nativeCatalog, unexpected: true } },
    { catalog: { ...nativeCatalog, modelPins: [{ ...nativeCatalog.modelPins[0], host: 'other' }] } },
    { catalog: { ...nativeCatalog, selections: [{ ...nativeCatalog.selections[0], fixtureId: 'fixture:missing' }] } },
    { catalog: { ...nativeCatalog, selections: [...nativeCatalog.selections, nativeCatalog.selections[0]] } },
    { catalog: { ...nativeCatalog, modelPins: [...nativeCatalog.modelPins, nativeCatalog.modelPins[0]] } },
  ];

  for (const body of malformed) {
    const client = new PlaygroundClient({ fetch: hostileFetch(body) });
    await expect(client.catalog('epoch/native')).rejects.toMatchObject({ code: 'AB8043' });
  }
});

it('rejects native catalog arrays with enumerable non-index own properties before Zod snapshots them', async () => {
  const withExtraArrayKey = <Entry,>(entries: readonly Entry[]): Entry[] => {
    const hostile = [...entries];
    Object.defineProperty(hostile, '4294967295', { enumerable: true, value: 'not-an-array-index' });
    return hostile;
  };
  const malformed: readonly unknown[] = [
    { catalog: { ...nativeCatalog, selections: withExtraArrayKey(nativeCatalog.selections) } },
    { catalog: { ...nativeCatalog, modelPins: withExtraArrayKey(nativeCatalog.modelPins) } },
  ];

  for (const body of malformed) {
    const client = new PlaygroundClient({ fetch: hostileFetch(body) });
    await expect(client.catalog('epoch/native')).rejects.toMatchObject({ code: 'AB8043' });
  }
});

it('cancels a run then reads its server-owned session by encoded identity', async () => {
  const calls: RecordedRequest[] = [];
  const client = new PlaygroundClient({ fetch: recordingFetch(calls, () => response(calls.length === 1 ? { cancelled: true } : { session })) });

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
    fetch: recordingFetch(calls, () => response(calls.length === 1
      ? { replay: { cursor: { afterSequence: 2 }, events: [event(1, 'Bound.'), event(2, 'Inspected.')], session: terminal } }
      : calls.length === 2
        ? { export: { events: [event(1, 'Bound.')], session: terminal } }
        : {
            draftEvalCase: {
              assertions: [], epoch: identity.epoch, fixture: identity.fixture, invocation: identity.invocation,
              outcome: { status: 'passed' }, target: identity.target, task: identity.task,
            },
          }),
    ),
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
    fetch: async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return response({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      expect(url).toBe('/api/playground/sessions/session-1/stream?after=1');
      return ndjson([`${first}\n${second.slice(0, half)}`, `${second.slice(half)}\n`]);
    },
  });

  const stream = client.stream('session-1', { afterSequence: 1, onEvent: (entry) => received.push(entry) });
  await stream.done;

  expect(received.map((entry) => entry.rawEventRef)).toEqual(['events.jsonl#1', 'events.jsonl#2']);
  expect(Object.isFrozen(received[0])).toBe(true);
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const client = new PlaygroundClient({
    fetch: recordingFetch([], () => response({ diagnostic: { code: 'AB8046', message: 'Playground session is already finalized.' } }, 409)),
  });

  await expect(client.session('session-1')).rejects.toMatchObject({ code: 'AB8046' });
});

it('rejects malformed or hostile server envelopes through the stable foreground diagnostic', async () => {
  const terminal = { ...session, outcome: { status: 'passed' }, state: 'finalized' };
  const inheritedIdentity = Object.create(identity) as object;
  const accessorSession = { ...session } as Record<string, unknown>;
  Object.defineProperty(accessorSession, 'identity', {
    enumerable: true,
    get: () => { throw new Error('hostile accessor'); },
  });
  const proxySession = new Proxy({ ...session }, {
    ownKeys: () => { throw new Error('hostile proxy'); },
  });
  const cases: readonly {
    readonly body: unknown;
    readonly invoke: (client: PlaygroundClient) => Promise<unknown>;
    readonly name: string;
  }[] = [
    {
      body: { run: { id: 'run-1', session: { ...session, identity: {} } } },
      invoke: (client) => client.run({ operation: 'skill.inspect', skillId: 'review', target: 'portable' }),
      name: 'a run with a missing identity epoch',
    },
    {
      body: { session: { ...session, identity: { ...identity, target: { digest: 7, name: 'portable' } } } },
      invoke: (client) => client.session('session-1'),
      name: 'a session with a non-string target digest',
    },
    {
      body: { session: { ...session, identity: { ...identity, fixture: { digest: 'sha256-fixture' } } } },
      invoke: (client) => client.session('session-1'),
      name: 'a session with an incomplete fixture identity',
    },
    {
      body: { session: { ...session, state: 'still-running' } },
      invoke: (client) => client.session('session-1'),
      name: 'a session with an unsupported state',
    },
    {
      body: { replay: { cursor: { afterSequence: -1 }, events: [], session: terminal } },
      invoke: (client) => client.replay('session-1'),
      name: 'a replay with a negative cursor',
    },
    {
      body: { export: { events: [{ ...event(1, 'Bound.'), rawEventRef: 'forged.jsonl#1' }], session: terminal } },
      invoke: (client) => client.export('session-1'),
      name: 'an export with a forged event reference',
    },
    {
      body: { export: { events: [], schemaVersion: 1, session: terminal } },
      invoke: (client) => client.export('session-1'),
      name: 'a versioned export outside the canonical contract',
    },
    {
      body: {
        draftEvalCase: {
          assertions: [], epoch: identity.epoch, fixture: identity.fixture, invocation: identity.invocation,
          outcome: { status: 7 }, target: identity.target, task: identity.task,
        },
      },
      invoke: (client) => client.promoteToDraftEval('session-1', ['events.jsonl#1']),
      name: 'a draft with a malformed durable outcome',
    },
    {
      body: {
        draftEvalCase: {
          assertions: [], epoch: identity.epoch, fixture: identity.fixture, invocation: identity.invocation,
          outcome: { status: 'passed' }, schemaVersion: 1, target: identity.target, task: identity.task,
        },
      },
      invoke: (client) => client.promoteToDraftEval('session-1', ['events.jsonl#1']),
      name: 'a versioned draft outside the canonical contract',
    },
    {
      body: { run: { id: 'run-1', session: accessorSession } },
      invoke: (client) => client.run({ operation: 'skill.inspect', skillId: 'review', target: 'portable' }),
      name: 'an accessor-backed session',
    },
    {
      body: { run: { id: 'run-1', session: proxySession } },
      invoke: (client) => client.run({ operation: 'skill.inspect', skillId: 'review', target: 'portable' }),
      name: 'a proxy-backed session',
    },
    {
      body: { run: { id: 'run-1', session: { ...session, identity: inheritedIdentity } } },
      invoke: (client) => client.run({ operation: 'skill.inspect', skillId: 'review', target: 'portable' }),
      name: 'a prototype-backed identity',
    },
  ];

  for (const entry of cases) {
    const client = new PlaygroundClient({ fetch: hostileFetch(entry.body) });
    await expect(entry.invoke(client), entry.name).rejects.toMatchObject({ code: 'AB8043' });
  }
});

it('detaches and freezes every accepted nested server envelope before returning it to React', async () => {
  const mutable = JSON.parse(JSON.stringify({ run: { id: 'run-1', session } })) as { run: { id: string; session: typeof session } };
  const client = new PlaygroundClient({ fetch: hostileFetch(mutable) });

  const run = await client.run({ operation: 'skill.inspect', skillId: 'review', target: 'portable' });
  mutable.run.session.identity.epoch.id = 'mutated-after-decode';

  expect(run.session.identity.epoch.id).toBe('epoch-1');
  expect(Object.isFrozen(run)).toBe(true);
  expect(Object.isFrozen(run.session.identity.epoch)).toBe(true);
  expect(Object.isFrozen(run.session.cleanupFailures)).toBe(true);
});
