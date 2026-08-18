import { expect, it } from '@rstest/core';

import { ComparisonClient } from '../src/comparisons/comparison-client.ts';
import { EvalClient } from '../src/evals/eval-client.ts';
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
  provenance: {
    hostCliVersion: 'agent-bundle@0.1.0',
    invocation: { mode: 'automatic' },
    semanticGrader: null,
  },
  rawArtifacts: ['artifacts/portable-1/evidence.json'],
  schemaVersion: 1,
  startedAt: '2026-08-17T00:00:00.500Z',
  targetDigest: 'c'.repeat(64),
  trialIndex: 0,
  usage: { inputTokens: 9, outputTokens: 3 },
};

const runResult = { aggregates: [], diagnostics: [], run: runRecord, trials: [trialRecord] };

const comparison = {
  baselineRunId: runRecord.id,
  candidateRunId: runRecord.id,
  rows: [],
  sampleSize: 1,
  summary: { comparable: 0, nonComparable: 0, reliability: 0, smoke: 0 },
};

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

const client = (fetch: typeof globalThis.fetch): EvalClient => new EvalClient({
  foreground: new ForegroundRouteClient({ fetch }),
});

it('lists discovered suites over the same foreground session', async () => {
  const calls: RecordedRequest[] = [];
  const evalClient = client(recordingFetch(calls, () => response(listing)));

  await expect(evalClient.suites()).resolves.toMatchObject({ suites: [{ name: 'review-change' }] });
  expect(calls).toEqual([{ body: undefined, method: 'GET', token: 'foreground-token', url: '/api/evals/suites' }]);
});

it('admits a run with the selected closed harness and keeps the response detached', async () => {
  const calls: RecordedRequest[] = [];
  const evalClient = client(recordingFetch(calls, () => response({ run: runRecord }, 202)));

  await expect(evalClient.start({ caseIds: ['reads-result'], harness: 'codex', suites: ['review-change'], trials: 2 }))
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
  const evalClient = client(recordingFetch(calls, () => response({ run: runRecord }, 202)));

  await evalClient.start({ suites: ['review-change'] });

  expect(calls[0]?.body).toEqual({ suites: ['review-change'] });
});

it('requires the documented 202 admission status', async () => {
  const evalClient = client(recordingFetch([], () => response({ run: runRecord })));

  await expect(evalClient.start({ suites: ['review-change'] })).rejects.toMatchObject({ code: 'AB8073' });
});

it('rejects malformed detached admission and cancellation DTOs', async () => {
  const admission = client(recordingFetch([], () => response({ run: runRecord, trials: [] }, 202)));
  const cancellation = client(recordingFetch([], () => response({ cancelled: true, runId: 'other-run' }, 202)));

  await expect(admission.start({ suites: ['review-change'] })).rejects.toMatchObject({ code: 'AB8073' });
  await expect(cancellation.cancel(runRecord.id)).rejects.toMatchObject({ code: 'AB8073' });
});

it('posts an exact empty body to cancel a server-owned run and decodes the idempotent result', async () => {
  const calls: RecordedRequest[] = [];
  const evalClient = client(recordingFetch(calls, () => response({ cancelled: false, runId: runRecord.id }, 202)));

  await expect(evalClient.cancel(runRecord.id)).resolves.toEqual({ cancelled: false, runId: runRecord.id });
  expect(calls).toEqual([{
    body: {},
    method: 'POST',
    token: 'foreground-token',
    url: `/api/evals/runs/${runRecord.id}/cancel`,
  }]);
});

it('rejects a cancellation response for another run', async () => {
  const evalClient = client(recordingFetch([], () => response({ cancelled: true, runId: 'another-run' }, 202)));

  await expect(evalClient.cancel(runRecord.id)).rejects.toMatchObject({ code: 'AB8073' });
});

it('reads one recorded run and lists every recorded run', async () => {
  const calls: RecordedRequest[] = [];
  let reply = 0;
  const evalClient = client(
    recordingFetch(calls, () => response(reply++ === 0 ? { run: runResult } : { runs: [runRecord] })),
  );

  await expect(evalClient.read('20260817t000000000z-abcdef01')).resolves.toMatchObject({ trials: [{ id: 'portable-1' }] });
  await expect(evalClient.runs()).resolves.toMatchObject([{ id: runRecord.id }]);
  expect(calls.map((call) => call.url)).toEqual([
    '/api/evals/runs/20260817t000000000z-abcdef01',
    '/api/evals/runs',
  ]);
});

it('decodes automatic invocation Skill provenance without weakening identifier safety', async () => {
  const resultWithSkill = (skill: string) => ({
    run: {
      ...runResult,
      trials: [{
        ...trialRecord,
        provenance: { ...trialRecord.provenance, invocation: { mode: 'automatic', skill } },
      }],
    },
  });

  await expect(client(recordingFetch([], () => response(resultWithSkill('release-notes')))).read(runRecord.id))
    .resolves.toMatchObject({ trials: [{ provenance: { invocation: { mode: 'automatic', skill: 'release-notes' } } }] });

  for (const skill of ['../outside', 'C:private', 'C:\\private', 'C:/private', '\\\\server\\share', 'file:///private/skill']) {
    await expect(client(recordingFetch([], () => response(resultWithSkill(skill)))).read(runRecord.id))
      .rejects.toMatchObject({ code: 'AB8073' });
  }
});

it('accepts legacy omitted trial provenance and usage but rejects unsafe or malformed additions', async () => {
  const { provenance: _provenance, usage: _usage, ...legacyTrial } = trialRecord;
  const cases: readonly unknown[] = [
    { run: { ...runResult, trials: [legacyTrial] } },
    { run: { ...runResult, trials: [{ ...trialRecord, provenance: { ...trialRecord.provenance, extra: true } }] } },
    { run: { ...runResult, trials: [{ ...trialRecord, provenance: { ...trialRecord.provenance, hostCliVersion: '/private/cli' } }] } },
    ...['C:private', 'C:\\private', 'C:/private', '\\\\server\\share', 'file:///private/cli'].map((hostCliVersion) => ({
      run: { ...runResult, trials: [{ ...trialRecord, provenance: { ...trialRecord.provenance, hostCliVersion } }] },
    })),
    { run: { ...runResult, trials: [{ ...trialRecord, provenance: { ...trialRecord.provenance, invocation: { mode: 'explicit' } } }] } },
    { run: { ...runResult, trials: [{ ...trialRecord, usage: { inputTokens: 9, outputTokens: -1 } }] } },
  ];

  const legacy = client(recordingFetch([], () => response(cases[0])));
  const legacyResult = await legacy.read(runRecord.id);
  expect(legacyResult.trials[0]).toMatchObject({ id: trialRecord.id });
  expect(legacyResult.trials[0]).not.toHaveProperty('provenance');
  expect(legacyResult.trials[0]).not.toHaveProperty('usage');

  const unrecorded = client(recordingFetch([], () => response({
    run: {
      ...runResult,
      trials: [{
        ...trialRecord,
        provenance: {
          ...trialRecord.provenance,
          invocation: { mode: 'explicit', skill: 'hook:fixture' },
          semanticGrader: { state: 'unrecorded' },
        },
      }],
    },
  })));
  await expect(unrecorded.read(runRecord.id)).resolves.toMatchObject({
    trials: [{ provenance: { invocation: { mode: 'explicit', skill: 'hook:fixture' }, semanticGrader: { state: 'unrecorded' } } }],
  });

  for (const body of cases.slice(1)) {
    const evalClient = client(recordingFetch([], () => response(body)));
    await expect(evalClient.read(runRecord.id)).rejects.toMatchObject({ code: 'AB8073' });
  }
});

it('replays only a detached, contiguous persisted event timeline from its cursor', async () => {
  const calls: RecordedRequest[] = [];
  const evalClient = client(recordingFetch(calls, () => response({
    replay: {
      cursor: { afterSequence: 2 },
      events: [
        { kind: 'run.started', payload: { trials: 1 }, schemaVersion: 1, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' },
        { kind: 'trial.completed', payload: { outcome: 'pass' }, schemaVersion: 1, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' },
      ],
    },
  })));

  const replay = await evalClient.events(runRecord.id, 0);

  expect(replay.cursor).toEqual({ afterSequence: 2 });
  expect(replay.events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(Object.isFrozen(replay)).toBe(true);
  expect(Object.isFrozen(replay.events[0]?.payload)).toBe(true);
  expect(calls[0]?.url).toBe(`/api/evals/runs/${runRecord.id}/events?after=0`);
});

it('rejects a duplicate-key or reordered event replay instead of retaining a hostile response object', async () => {
  const duplicate = client(recordingFetch([], () => new Response(
    '{"replay":{"cursor":{"afterSequence":1},"events":[{"kind":"run.started","payload":{},"schemaVersion":1,"sequence":1,"sequence":2,"timestamp":"2026-08-17T00:00:00.000Z"}]}}',
    { headers: { 'content-type': 'application/json' } },
  )));
  const reordered = client(recordingFetch([], () => response({ replay: {
    cursor: { afterSequence: 2 },
    events: [
      { kind: 'trial.completed', payload: {}, schemaVersion: 1, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' },
    ],
  } })));

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
  const evalClient = client(async (input) => {
    const url = String(input);
    if (url === '/api/project/session') return response({
      cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
      origin: 'http://127.0.0.1:5173',
      token: 'foreground-token',
    });
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
  });
  const events: number[] = [];
  const complete = evalClient.stream({ afterSequence: 0, onEvent: (event) => { events.push(event.sequence); }, runId: runRecord.id });
  await complete.done;
  expect(events).toEqual([1, 2]);
  const replacement = evalClient.stream({ afterSequence: 2, onEvent: () => { throw new Error('An aborted stream must not publish.'); }, runId: runRecord.id });
  await replacementOpened;
  replacement.close();
  await replacement.done;
  expect(cancelled).toBe(true);
});

it('fetches an opaque persisted artifact through the foreground session without exposing a direct path', async () => {
  const calls: string[] = [];
  const evalClient = client(async (input) => {
    const url = String(input);
    if (url === '/api/project/session') return response({
      cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
      origin: 'http://127.0.0.1:5173',
      token: 'foreground-token',
    });
    calls.push(url);
    return new Response('{"evidence":true}\n', {
      headers: {
        'content-disposition': 'attachment; filename="evidence.json"',
        'content-length': '18',
        'content-type': 'application/json; charset=utf-8',
      },
    });
  });

  const artifact = await evalClient.artifact(runRecord.id, 'artifacts/portable-1/evidence.json');

  expect(artifact.filename).toBe('evidence.json');
  await expect(artifact.blob.text()).resolves.toBe('{"evidence":true}\n');
  expect(calls).toEqual([`/api/evals/runs/${runRecord.id}/artifacts/${Buffer.from('artifacts/portable-1/evidence.json').toString('base64url')}`]);
});

it('encodes a run identifier into the request path', async () => {
  const calls: RecordedRequest[] = [];
  const evalClient = client(recordingFetch(calls, () => response({ run: runResult })));

  await evalClient.read('run a/b');

  expect(calls[0]?.url).toBe('/api/evals/runs/run%20a%2Fb');
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const evalClient = client(
    recordingFetch([], () => response({
      diagnostic: { code: 'AB8076', message: 'No discovered eval suite or case matched this selection.' },
    }, 422)),
  );

  await expect(evalClient.start({ suites: ['absent'] })).rejects.toMatchObject({
    code: 'AB8076',
    message: 'No discovered eval suite or case matched this selection.',
  });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const evalClient = client(recordingFetch([], () => response({}, 503)));

  await expect(evalClient.suites()).rejects.toMatchObject({
    code: 'AB8073',
    message: 'Eval request failed with HTTP 503.',
  });
});

it('rejects a response that does not carry the documented shape', async () => {
  const evalClient = client(recordingFetch([], () => response({ suites: 'review-change' })));

  await expect(evalClient.suites()).rejects.toMatchObject({ code: 'AB8073' });
});

it('shares one foreground bootstrap across eval and comparison routes and fences both after invalidation', async () => {
  let bootstraps = 0;
  let resolveHeld: ((response: Response) => void) | undefined;
  const held = new Promise<Response>((resolvePromise) => { resolveHeld = resolvePromise; });
  let holdSuite = false;
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/project/session') {
      bootstraps += 1;
      return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
    }
    if (path === '/api/evals/suites') return holdSuite ? held : response(listing);
    if (path === '/api/evals/comparisons?base=baseline&candidate=candidate') return response({ comparison });
    throw new Error(`Unexpected route ${path}`);
  };
  const foreground = new ForegroundRouteClient({ fetch });
  const evalClient = new EvalClient({ foreground });
  const comparisonClient = new ComparisonClient({ foreground });

  await Promise.all([
    evalClient.suites(),
    comparisonClient.compare({ base: 'baseline', candidate: 'candidate' }),
  ]);
  expect(bootstraps).toBe(1);

  holdSuite = true;
  const stale = evalClient.suites();
  await Promise.resolve();
  foreground.forgetAuthentication();
  resolveHeld?.(response(listing));

  await expect(stale).rejects.toMatchObject({ code: 'AB8019' });
  await expect(comparisonClient.compare({ base: 'baseline', candidate: 'candidate' })).resolves.toMatchObject({
    baselineRunId: runRecord.id,
  });
  expect(bootstraps).toBe(2);
});

it('rejects extra or nonsensical fields anywhere in suite and run DTOs', async () => {
  const cases: readonly (readonly [unknown, (client: EvalClient) => Promise<unknown>])[] = [
    [{ ...listing, suites: [{ ...listing.suites[0], cases: [{ ...listing.suites[0]!.cases[0], extra: true }] }] }, (client) => client.suites()],
    [{ run: { ...runResult, run: { ...runRecord, extra: true } } }, (client) => client.read(runRecord.id)],
    [{ extra: true, runs: [runRecord] }, (client) => client.runs()],
    [{ runs: [{ ...runRecord, summary: { ...runRecord.summary, trials: -1 } }] }, (client) => client.runs()],
  ];

  for (const [body, operation] of cases) {
    const evalClient = client(recordingFetch([], () => response(body)));
    await expect(operation(evalClient)).rejects.toMatchObject({ code: 'AB8073' });
  }
});
