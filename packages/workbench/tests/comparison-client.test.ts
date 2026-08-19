import { expect, it } from '@rstest/core';

import { ComparisonClient } from '../src/comparisons/comparison-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';

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
    baseline: {
      durationMs: 3000,
      evidence: 'reliability',
      fail: 1,
      harnessFailures: 0,
      inconclusive: 0,
      meanDurationMs: 1000,
      outcome: 'fail',
      passRate: 0.666667,
      passes: 2,
      provenance: { hostCliVersion: 'claude@1.0.0', invocation: 'explicit:hook:fixture', semanticGrader: 'none' },
      reliability: { passAtK: 1, passPowerK: 0, sampleSize: 3 },
      runId: 'run-base',
      trials: 3,
      usage: { inputTokens: 300, outputTokens: 25, recordedTrials: 3, totalTokens: 325 },
    },
    candidate: {
      durationMs: 3000,
      evidence: 'reliability',
      fail: 0,
      harnessFailures: 0,
      inconclusive: 0,
      meanDurationMs: 1000,
      outcome: 'pass',
      passRate: 1,
      passes: 3,
      provenance: { hostCliVersion: 'claude@1.0.0', invocation: 'explicit:hook:fixture', semanticGrader: 'none' },
      reliability: { passAtK: 1, passPowerK: 1, sampleSize: 3 },
      runId: 'run-candidate',
      trials: 3,
      usage: { inputTokens: 600, outputTokens: 25, recordedTrials: 3, totalTokens: 625 },
    },
    caseId: 'direct-review',
    comparable: true,
    delta: { meanDurationMs: 0, passRate: 0.333333, passes: 1, reliability: { passAtK: 0, passPowerK: 1, sampleSize: 3 }, trials: 0 },
    evidence: 'reliability',
    host: 'claude',
    model: 'sonnet',
  }],
  sampleSize: 3,
  summary: { comparable: 1, nonComparable: 0, reliability: 1, smoke: 0 },
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
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get('x-agent-bundle-session'),
      url,
    });
    return reply();
  };

const client = (fetch: typeof globalThis.fetch): ComparisonClient => new ComparisonClient({
  foreground: new ForegroundRouteClient({ fetch }),
});

it('requests an aligned comparison for a baseline and a candidate run', async () => {
  const calls: RecordedRequest[] = [];
  const comparisonClient = client(recordingFetch(calls, () => response({ comparison })));

  const result = await comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(result).toMatchObject({ baselineRunId: 'run-base', sampleSize: 3 });
  expect(result.rows[0]).toMatchObject({ caseId: 'direct-review', comparable: true });
  expect(calls).toEqual([{
    method: 'GET',
    token: 'foreground-token',
    url: '/api/evals/comparisons?base=run-base&candidate=run-candidate',
  }]);
});

it('freezes the decoded comparison so a page cannot mutate it', async () => {
  const comparisonClient = client(recordingFetch([], () => response({ comparison })));

  const result = await comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.rows)).toBe(true);
  expect(Object.isFrozen(result.rows[0])).toBe(true);
});

it('strictly decodes nested provenance and usage while preserving unrecorded semantic grading', async () => {
  const unrecorded = structuredClone(comparison) as {
    rows: Array<{ baseline?: { provenance: { semanticGrader: unknown } } }>;
  };
  const baseline = unrecorded.rows[0]?.baseline;
  if (baseline === undefined) throw new Error('Comparison fixture must include a baseline.');
  baseline.provenance.semanticGrader = { state: 'unrecorded' };
  const comparisonClient = client(recordingFetch([], () => response({ comparison: unrecorded })));

  const result = await comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(result.rows[0]).toMatchObject({ baseline: { provenance: { semanticGrader: { state: 'unrecorded' } } } });
  expect(Object.isFrozen(result.rows[0]?.baseline?.provenance)).toBe(true);
  expect(Object.isFrozen(result.rows[0]?.baseline?.usage)).toBe(true);
});

it('accepts the canonical semantic grader identity without a schema-version suffix', async () => {
  const canonical = structuredClone(comparison) as {
    rows: Array<{ baseline?: { provenance: { semanticGrader: unknown } } }>;
  };
  const baseline = canonical.rows[0]?.baseline;
  if (baseline === undefined) throw new Error('Comparison fixture must include a baseline.');
  baseline.provenance.semanticGrader = 'claude-semantic@sonnet';
  const comparisonClient = client(recordingFetch([], () => response({ comparison: canonical })));

  const result = await comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(result.rows[0]).toMatchObject({
    baseline: { provenance: { semanticGrader: 'claude-semantic@sonnet' } },
  });
});

it('decodes the canonical semantic-grader identity mismatch cause', async () => {
  const aligned = comparison.rows[0]!;
  const semanticMismatch = {
    ...comparison,
    rows: [{
      baseline: aligned.baseline,
      candidate: aligned.candidate,
      caseId: aligned.caseId,
      causes: [{
        baseline: 'claude-semantic@sonnet',
        candidate: 'claude-semantic@opus',
        code: 'semantic-grader-identity-mismatch',
        message: 'The semantic grader identities do not align.',
      }],
      comparable: false,
      host: aligned.host,
    }],
    summary: { comparable: 0, nonComparable: 1, reliability: 0, smoke: 0 },
  };
  const comparisonClient = client(recordingFetch([], () => response({ comparison: semanticMismatch })));

  const result = await comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' });

  expect(result.rows[0]).toMatchObject({
    causes: [{ code: 'semantic-grader-identity-mismatch' }],
    comparable: false,
  });
});

it('rejects extra, path-shaped, or negative nested comparison data', async () => {
  const invalid = [
    { provenance: { hostCliVersion: '2.1.232', invocation: 'automatic', semanticGrader: 'none', unexpected: true } },
    { provenance: { hostCliVersion: '/private/bin/claude', invocation: 'automatic', semanticGrader: 'none' } },
    { provenance: { hostCliVersion: '2.1.232', invocation: 'automatic', semanticGrader: 'claude-semantic@sonnet/v1' } },
    { usage: { inputTokens: 300, outputTokens: -1, recordedTrials: 3, totalTokens: 299 } },
    { usage: { inputTokens: 0, outputTokens: 0, recordedTrials: 0, totalTokens: 0 } },
    { usage: { inputTokens: 300, outputTokens: 25, recordedTrials: 4, totalTokens: 325 } },
  ];

  for (const mutation of invalid) {
    const malformed = structuredClone(comparison);
    const baseline = malformed.rows[0]?.baseline;
    if (baseline === undefined) throw new Error('Comparison fixture must include a baseline.');
    Object.assign(baseline, mutation);
    const comparisonClient = client(recordingFetch([], () => response({ comparison: malformed })));
    await expect(comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' })).rejects.toMatchObject({ code: 'AB8083' });
  }
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const comparisonClient = client(
    recordingFetch([], () => response({
      diagnostic: { code: 'AB8071', message: 'Eval comparison requires two recorded runs.' },
    }, 400)),
  );

  await expect(comparisonClient.compare({ base: 'run-base', candidate: 'missing' })).rejects.toMatchObject({
    code: 'AB8071',
    message: 'Eval comparison requires two recorded runs.',
  });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const comparisonClient = client(recordingFetch([], () => response({}, 503)));

  await expect(comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' })).rejects.toMatchObject({
    code: 'AB8083',
    message: 'Eval comparison request failed with HTTP 503.',
  });
});

it('rejects a response that is not a comparison', async () => {
  const comparisonClient = client(recordingFetch([], () => response({ comparison: { rows: 'none' } })));

  await expect(comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' })).rejects.toMatchObject({
    code: 'AB8083',
  });
});

it('rejects missing, path-like, or structurally extended metric provenance', async () => {
  const row = comparison.rows[0];
  const invalidProvenance = [
    undefined,
    { hostCliVersion: '/private/claude' },
    ...['C:private', 'C:\\private', 'C:/private', '\\\\server\\share', 'file:///private/claude']
      .map((hostCliVersion) => ({ hostCliVersion })),
    { hostCliVersion: 'claude@1.0.0', unexpected: 'value' },
  ];

  for (const provenance of invalidProvenance) {
    const comparisonClient = client(recordingFetch([], () => response({
      comparison: {
        ...comparison,
        rows: [{ ...row, baseline: { ...row.baseline, provenance } }],
      },
    })));

    await expect(comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' })).rejects.toMatchObject({
      code: 'AB8083',
    });
  }
});

it('uses the shared foreground authority error when its authentication is invalidated', async () => {
  let resolveComparison: ((value: Response) => void) | undefined;
  const pendingComparison = new Promise<Response>((resolvePromise) => { resolveComparison = resolvePromise; });
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => String(input) === '/api/project/session'
      ? response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      })
      : pendingComparison,
  });
  const comparisonClient = new ComparisonClient({ foreground });
  const request = comparisonClient.compare({ base: 'run-base', candidate: 'run-candidate' });
  await Promise.resolve();
  foreground.forgetAuthentication();
  resolveComparison?.(response({ comparison }));

  await expect(request).rejects.toMatchObject({ code: 'AB8019' });
});
