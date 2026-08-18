import { expect, it } from '@rstest/core';

import { ComparisonClient } from '../src/comparisons/comparison-client.ts';

interface RecordedRequest {
  readonly method: string;
  readonly token: string | null;
  readonly url: string;
}

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const comparison = {
  baselineRunId: 'run-base',
  candidateRunId: 'run-candidate',
  rows: [{
    baseline: { durationMs: 3000, evidence: 'reliability', fail: 1, harnessFailures: 0, inconclusive: 0, meanDurationMs: 1000, outcome: 'fail', passRate: 0.666667, passes: 2, reliability: { passAtK: 1, passPowerK: 0, sampleSize: 3 }, runId: 'run-base', trials: 3 },
    candidate: { durationMs: 3000, evidence: 'reliability', fail: 0, harnessFailures: 0, inconclusive: 0, meanDurationMs: 1000, outcome: 'pass', passRate: 1, passes: 3, reliability: { passAtK: 1, passPowerK: 1, sampleSize: 3 }, runId: 'run-candidate', trials: 3 },
    caseId: 'direct-review',
    comparable: true,
    delta: { meanDurationMs: 0, passRate: 0.333333, passes: 1, reliability: { passAtK: 0, passPowerK: 1, sampleSize: 3 }, trials: 0 },
    evidence: 'reliability',
    host: 'claude',
    model: 'sonnet',
    unverifiedFacets: [],
  }],
  sampleSize: 3,
  summary: { comparable: 1, nonComparable: 0, reliability: 1, smoke: 0 },
};

const recordingFetch = (calls: RecordedRequest[], reply: () => Response): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
    calls.push({
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get('x-agent-bundle-session'),
      url,
    });
    return reply();
  };

it('requests an aligned comparison for a baseline and a candidate run', async () => {
  const calls: RecordedRequest[] = [];
  const client = new ComparisonClient({ fetch: recordingFetch(calls, () => response({ comparison })) });

  const result = await client.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(result).toMatchObject({ baselineRunId: 'run-base', sampleSize: 3 });
  expect(result.rows[0]).toMatchObject({ caseId: 'direct-review', comparable: true });
  expect(calls).toEqual([{
    method: 'GET',
    token: 'foreground-token',
    url: '/api/evals/comparisons?base=run-base&candidate=run-candidate',
  }]);
});

it('freezes the decoded comparison so a page cannot mutate it', async () => {
  const client = new ComparisonClient({ fetch: recordingFetch([], () => response({ comparison })) });

  const result = await client.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.rows)).toBe(true);
  expect(Object.isFrozen(result.rows[0])).toBe(true);
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const client = new ComparisonClient({
    fetch: recordingFetch([], () => response({
      diagnostic: { code: 'AB8071', message: 'Eval comparison requires two recorded runs.' },
    }, 400)),
  });

  await expect(client.compare({ base: 'run-base', candidate: 'missing' })).rejects.toMatchObject({
    code: 'AB8071',
    message: 'Eval comparison requires two recorded runs.',
  });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const client = new ComparisonClient({ fetch: recordingFetch([], () => response({}, 503)) });

  await expect(client.compare({ base: 'run-base', candidate: 'run-candidate' })).rejects.toMatchObject({
    code: 'AB8083',
    message: 'Eval comparison request failed with HTTP 503.',
  });
});

it('rejects a response that is not a comparison', async () => {
  const client = new ComparisonClient({ fetch: recordingFetch([], () => response({ comparison: { rows: 'none' } })) });

  await expect(client.compare({ base: 'run-base', candidate: 'run-candidate' })).rejects.toMatchObject({
    code: 'AB8083',
  });
});

it('refuses a foreground session bootstrap that does not match this browser origin', async () => {
  const client = new ComparisonClient({
    fetch: async () => response({ origin: 'http://127.0.0.1:5173/', token: 'foreground-token' }),
  });

  await expect(client.compare({ base: 'run-base', candidate: 'run-candidate' })).rejects.toMatchObject({ code: 'AB8083' });
});

it('forgets the foreground token when the owning page stops using it', async () => {
  let bootstraps = 0;
  const client = new ComparisonClient({
    fetch: async (input) => {
      if (String(input) === '/api/project/session') {
        bootstraps += 1;
        return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      }
      return response({ comparison });
    },
  });

  await client.compare({ base: 'run-base', candidate: 'run-candidate' });
  await client.compare({ base: 'run-base', candidate: 'run-candidate' });
  client.forgetAuthentication();
  await client.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(bootstraps).toBe(2);
});
