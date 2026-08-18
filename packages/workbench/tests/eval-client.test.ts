import { expect, it } from '@rstest/core';

import { EvalClient } from '../src/evals/eval-client.ts';

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

const runRecord = {
  agentBundleVersion: '0.1.0',
  artifact: {
    manifestPath: 'agent-bundle.manifest.json',
    source: 'run-owned',
    targetDigests: { portable: 'c'.repeat(64) },
  },
  completedAt: '2026-08-17T00:00:02.000Z',
  createdAt: '2026-08-17T00:00:00.000Z',
  harness: 'deterministic',
  id: '20260817t000000000z-abcdef01',
  projectRevision: 'd'.repeat(64),
  schemaVersion: 1,
  summary: { cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 },
};

const trialRecord = {
  assertions: [{
    assertionId: 'outcome:0123456789abcdef',
    detail: 'The grader passed.',
    evidence: 'observed',
    kind: 'outcome',
    outcome: 'pass',
  }],
  caseDigest: 'a'.repeat(64),
  caseId: 'reads-result',
  completedAt: '2026-08-17T00:00:01.000Z',
  durationMs: 12,
  evidence: {
    mcp: { calls: [], level: 'unavailable' },
    process: { level: 'unavailable', timedOut: false },
    scripts: { level: 'observed', results: {} },
    skillActivation: { activated: [], level: 'unavailable' },
  },
  fixtureDigest: 'b'.repeat(64),
  host: 'portable',
  id: 'portable-1',
  model: 'deterministic',
  outcome: 'pass',
  prompt: 'Report the highest-risk regression.',
  rawArtifacts: ['artifacts/portable-1/evidence.json'],
  schemaVersion: 1,
  startedAt: '2026-08-17T00:00:00.500Z',
  targetDigest: 'c'.repeat(64),
  trialIndex: 0,
};

const runResult = { aggregates: [], diagnostics: [], run: runRecord, trials: [trialRecord] };

const listing = {
  diagnostics: [],
  suites: [{
    cases: [{
      assertions: [{ id: 'outcome:0123456789abcdef', kind: 'outcome' }],
      digest: 'a'.repeat(64),
      hosts: ['portable'],
      id: 'reads-result',
      invocation: { mode: 'automatic' },
      prompt: 'Report the highest-risk regression.',
      trials: 1,
    }],
    digest: 'e'.repeat(64),
    name: 'review-change',
    sourcePath: 'evals/review.eval.ts',
  }],
};

const recordingFetch = (calls: RecordedRequest[], reply: () => Response): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
    calls.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get('x-agent-bundle-session'),
      url,
    });
    return reply();
  };

it('lists discovered suites over the same foreground session', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response(listing)) });

  await expect(client.suites()).resolves.toMatchObject({ suites: [{ name: 'review-change' }] });
  expect(calls).toEqual([{ body: undefined, method: 'GET', token: 'foreground-token', url: '/api/evals/suites' }]);
});

it('admits a run with the selected closed harness and keeps the response detached', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response({ run: runRecord }, 202)) });

  await expect(client.start({ caseIds: ['reads-result'], harness: 'codex', suites: ['review-change'], trials: 2 }))
    .resolves.toMatchObject({ run: { id: runRecord.id } });
  expect(calls).toEqual([{
    body: { caseIds: ['reads-result'], harness: 'codex', suites: ['review-change'], trials: 2 },
    method: 'POST',
    token: 'foreground-token',
    url: '/api/evals/runs',
  }]);
});

it('omits an absent selection field instead of sending an empty one', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response({ run: runRecord }, 202)) });

  await client.start({ suites: ['review-change'] });

  expect(calls[0]?.body).toEqual({ suites: ['review-change'] });
});

it('requires the documented 202 admission status', async () => {
  const client = new EvalClient({ fetch: recordingFetch([], () => response({ run: runRecord })) });

  await expect(client.start({ suites: ['review-change'] })).rejects.toMatchObject({ code: 'AB8073' });
});

it('rejects malformed detached admission and cancellation DTOs', async () => {
  const admission = new EvalClient({ fetch: recordingFetch([], () => response({ run: runRecord, trials: [] }, 202)) });
  const cancellation = new EvalClient({ fetch: recordingFetch([], () => response({ cancelled: true, runId: 'other-run' }, 202)) });

  await expect(admission.start({ suites: ['review-change'] })).rejects.toMatchObject({ code: 'AB8073' });
  await expect(cancellation.cancel(runRecord.id)).rejects.toMatchObject({ code: 'AB8073' });
});

it('posts an exact empty body to cancel a server-owned run and decodes the idempotent result', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response({ cancelled: false, runId: runRecord.id }, 202)) });

  await expect(client.cancel(runRecord.id)).resolves.toEqual({ cancelled: false, runId: runRecord.id });
  expect(calls).toEqual([{
    body: {},
    method: 'POST',
    token: 'foreground-token',
    url: `/api/evals/runs/${runRecord.id}/cancel`,
  }]);
});

it('reads one recorded run and lists every recorded run', async () => {
  const calls: RecordedRequest[] = [];
  let reply = 0;
  const client = new EvalClient({
    fetch: recordingFetch(calls, () => response(reply++ === 0 ? { run: runResult } : { runs: [runRecord] })),
  });

  await expect(client.read('20260817t000000000z-abcdef01')).resolves.toMatchObject({ trials: [{ id: 'portable-1' }] });
  await expect(client.runs()).resolves.toMatchObject([{ id: runRecord.id }]);
  expect(calls.map((call) => call.url)).toEqual([
    '/api/evals/runs/20260817t000000000z-abcdef01',
    '/api/evals/runs',
  ]);
});

it('replays only a detached, contiguous persisted event timeline from its cursor', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response({
    replay: {
      cursor: { afterSequence: 2 },
      events: [
        { kind: 'run.started', payload: { trials: 1 }, schemaVersion: 1, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' },
        { kind: 'trial.completed', payload: { outcome: 'pass' }, schemaVersion: 1, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' },
      ],
    },
  })) });

  const replay = await client.events(runRecord.id, 0);

  expect(replay.cursor).toEqual({ afterSequence: 2 });
  expect(replay.events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(Object.isFrozen(replay)).toBe(true);
  expect(Object.isFrozen(replay.events[0]?.payload)).toBe(true);
  expect(calls[0]?.url).toBe(`/api/evals/runs/${runRecord.id}/events?after=0`);
});

it('rejects a duplicate-key or reordered event replay instead of retaining a hostile response object', async () => {
  const duplicate = new EvalClient({
    fetch: async (input) => String(input) === '/api/project/session'
      ? response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' })
      : new Response('{"replay":{"cursor":{"afterSequence":1},"events":[{"kind":"run.started","payload":{},"schemaVersion":1,"sequence":1,"sequence":2,"timestamp":"2026-08-17T00:00:00.000Z"}]}}', {
        headers: { 'content-type': 'application/json' },
      }),
  });
  const reordered = new EvalClient({
    fetch: async (input) => String(input) === '/api/project/session'
      ? response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' })
      : response({ replay: {
        cursor: { afterSequence: 2 },
        events: [
          { kind: 'trial.completed', payload: {}, schemaVersion: 1, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' },
        ],
      } }),
  });

  await expect(duplicate.events(runRecord.id, 0)).rejects.toMatchObject({ code: 'AB8073' });
  await expect(reordered.events(runRecord.id, 0)).rejects.toMatchObject({ code: 'AB8073' });
});

it('decodes fragmented NDJSON in sequence and aborts a replacement stream without a stale callback', async () => {
  const encoder = new TextEncoder();
  const frames = [
    JSON.stringify({ kind: 'run.started', payload: {}, schemaVersion: 1, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }),
    JSON.stringify({ kind: 'run.completed', payload: {}, schemaVersion: 1, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' }),
    '',
  ].join('\n');
  let streamCalls = 0;
  let cancelled = false;
  let opened!: () => void;
  const replacementOpened = new Promise<void>((resolvePromise) => { opened = resolvePromise; });
  const client = new EvalClient({
    fetch: async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      streamCalls += 1;
      if (streamCalls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start: (controller) => {
            const bytes = encoder.encode(frames);
            controller.enqueue(bytes.subarray(0, 11));
            controller.enqueue(bytes.subarray(11));
            controller.close();
          },
        }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        cancel: () => { cancelled = true; },
        pull: () => {
          opened();
          return new Promise<void>(() => undefined);
        },
      }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
    },
  });
  const events: number[] = [];
  const complete = client.stream({ afterSequence: 0, onEvent: (event) => { events.push(event.sequence); }, runId: runRecord.id });
  await complete.done;
  expect(events).toEqual([1, 2]);
  const replacement = client.stream({ afterSequence: 2, onEvent: () => { throw new Error('An aborted stream must not publish.'); }, runId: runRecord.id });
  await replacementOpened;
  replacement.close();
  await replacement.done;
  expect(cancelled).toBe(true);
});

it('fetches an opaque persisted artifact through the foreground session without exposing a direct path', async () => {
  const calls: string[] = [];
  const client = new EvalClient({
    fetch: async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      calls.push(url);
      return new Response('{"evidence":true}\n', {
        headers: {
          'content-disposition': 'attachment; filename="evidence.json"',
          'content-length': '18',
          'content-type': 'application/json; charset=utf-8',
        },
      });
    },
  });

  const artifact = await client.artifact(runRecord.id, 'artifacts/portable-1/evidence.json');

  expect(artifact.filename).toBe('evidence.json');
  await expect(artifact.blob.text()).resolves.toBe('{"evidence":true}\n');
  expect(calls).toEqual([`/api/evals/runs/${runRecord.id}/artifacts/${Buffer.from('artifacts/portable-1/evidence.json').toString('base64url')}`]);
});

it('encodes a run identifier into the request path', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response({ run: runResult })) });

  await client.read('run a/b');

  expect(calls[0]?.url).toBe('/api/evals/runs/run%20a%2Fb');
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const client = new EvalClient({
    fetch: recordingFetch([], () => response({
      diagnostic: { code: 'AB8076', message: 'No discovered eval suite or case matched this selection.' },
    }, 422)),
  });

  await expect(client.start({ suites: ['absent'] })).rejects.toMatchObject({
    code: 'AB8076',
    message: 'No discovered eval suite or case matched this selection.',
  });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const client = new EvalClient({ fetch: recordingFetch([], () => response({}, 503)) });

  await expect(client.suites()).rejects.toMatchObject({
    code: 'AB8073',
    message: 'Eval request failed with HTTP 503.',
  });
});

it('rejects a response that does not carry the documented shape', async () => {
  const client = new EvalClient({ fetch: recordingFetch([], () => response({ suites: 'review-change' })) });

  await expect(client.suites()).rejects.toMatchObject({ code: 'AB8073' });
});

it('rejects extra or nonsensical fields anywhere in suite and run DTOs', async () => {
  const cases: readonly (readonly [unknown, (client: EvalClient) => Promise<unknown>])[] = [
    [{ ...listing, suites: [{ ...listing.suites[0], cases: [{ ...listing.suites[0]!.cases[0], extra: true }] }] }, (client) => client.suites()],
    [{ run: { ...runResult, run: { ...runRecord, extra: true } } }, (client) => client.read(runRecord.id)],
    [{ extra: true, runs: [runRecord] }, (client) => client.runs()],
    [{ runs: [{ ...runRecord, summary: { ...runRecord.summary, trials: -1 } }] }, (client) => client.runs()],
  ];

  for (const [body, operation] of cases) {
    const client = new EvalClient({ fetch: recordingFetch([], () => response(body)) });
    await expect(operation(client)).rejects.toMatchObject({ code: 'AB8073' });
  }
});
