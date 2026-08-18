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

it('posts only a suite, case, and trial selection when starting a run', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response({ run: runResult })) });

  await expect(client.start({ caseIds: ['reads-result'], suites: ['review-change'], trials: 2 }))
    .resolves.toMatchObject({ run: { id: runRecord.id } });
  expect(calls).toEqual([{
    body: { caseIds: ['reads-result'], suites: ['review-change'], trials: 2 },
    method: 'POST',
    token: 'foreground-token',
    url: '/api/evals/runs',
  }]);
});

it('omits an absent selection field instead of sending an empty one', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({ fetch: recordingFetch(calls, () => response({ run: runResult })) });

  await client.start({ suites: ['review-change'] });

  expect(calls[0]?.body).toEqual({ suites: ['review-change'] });
});

it('reads one recorded run and lists every recorded run', async () => {
  const calls: RecordedRequest[] = [];
  const client = new EvalClient({
    fetch: recordingFetch(calls, () => response({ run: runResult, runs: [runRecord] })),
  });

  await expect(client.read('20260817t000000000z-abcdef01')).resolves.toMatchObject({ trials: [{ id: 'portable-1' }] });
  await expect(client.runs()).resolves.toMatchObject([{ id: runRecord.id }]);
  expect(calls.map((call) => call.url)).toEqual([
    '/api/evals/runs/20260817t000000000z-abcdef01',
    '/api/evals/runs',
  ]);
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
