import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import { EvalRoutes, type EvalRouteService } from '../src/dev/eval-routes.ts';
import { EvalServiceError, type EvalRunRequest, type EvalRunResult, type EvalSuiteListing } from '../src/dev/eval-service.ts';
import type { EvalComparison } from '../src/eval/compare.ts';
import type { EvalRunRecord, EvalTrialRecord } from '../src/eval/run-store.ts';

interface StartedRoutes {
  readonly close: () => Promise<void>;
  readonly routes: EvalRoutes;
  readonly url: string;
}

const routeError = (code: string, message: string, status: number): Error & {
  readonly code: string;
  readonly status: number;
} => Object.assign(new Error(message), { code, message, status });

const authorize = (request: IncomingMessage): void => {
  if (request.headers.origin !== 'http://127.0.0.1:4567') {
    throw routeError('AB8003', 'Request origin is not this foreground server.', 403);
  }
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

const headers = Object.freeze({
  'content-type': 'application/json',
  origin: 'http://127.0.0.1:4567',
  'x-agent-bundle-session': 'test-session-token',
});

const runRecord: EvalRunRecord = Object.freeze({
  agentBundleVersion: '0.1.0',
  artifact: Object.freeze({
    manifestPath: '.agent-bundle/runs/run-a/artifacts/target/agent-bundle.manifest.json',
    source: 'run-owned',
    targetDigests: Object.freeze({ portable: 'c'.repeat(64) }),
  }),
  completedAt: '2026-08-17T00:00:02.000Z',
  createdAt: '2026-08-17T00:00:00.000Z',
  harness: 'deterministic',
  id: 'run-a',
  projectRevision: 'd'.repeat(64),
  schemaVersion: 1,
  summary: Object.freeze({ cases: 1, fail: 0, inconclusive: 1, pass: 1, trials: 2 }),
});

const trialRecord: EvalTrialRecord = Object.freeze({
  assertions: Object.freeze([Object.freeze({
    assertionId: 'outcome:0123456789abcdef',
    detail: 'The grader passed.',
    evidence: 'observed',
    kind: 'outcome',
    outcome: 'pass',
  })]),
  caseDigest: 'a'.repeat(64),
  caseId: 'reads-result',
  completedAt: '2026-08-17T00:00:01.000Z',
  durationMs: 12,
  evidence: Object.freeze({
    mcp: Object.freeze({ calls: Object.freeze([]), level: 'unavailable' }),
    process: Object.freeze({ level: 'unavailable', timedOut: false }),
    scripts: Object.freeze({ level: 'observed', results: Object.freeze({}) }),
    skillActivation: Object.freeze({ activated: Object.freeze([]), level: 'unavailable' }),
  }),
  fixtureDigest: 'b'.repeat(64),
  host: 'portable',
  id: 'portable-1',
  model: 'deterministic',
  outcome: 'pass',
  prompt: 'Report the highest-risk regression.',
  rawArtifacts: Object.freeze(['artifacts/portable-1/evidence.json']),
  schemaVersion: 1,
  startedAt: '2026-08-17T00:00:00.500Z',
  targetDigest: 'c'.repeat(64),
  trialIndex: 0,
});

const runResult: EvalRunResult = Object.freeze({
  aggregates: Object.freeze([]),
  diagnostics: Object.freeze([]),
  run: runRecord,
  trials: Object.freeze([trialRecord]),
});

const suiteListing: EvalSuiteListing = Object.freeze({
  diagnostics: Object.freeze([]),
  suites: Object.freeze([Object.freeze({
    cases: Object.freeze([Object.freeze({
      assertions: Object.freeze([Object.freeze({ id: 'outcome:0123456789abcdef', kind: 'outcome' as const })]),
      digest: 'a'.repeat(64),
      hosts: Object.freeze(['portable']),
      id: 'reads-result',
      invocation: Object.freeze({ mode: 'automatic' as const }),
      prompt: 'Report the highest-risk regression.',
      trials: 1,
    })]),
    digest: 'e'.repeat(64),
    name: 'review-change',
    sourcePath: 'evals/review.eval.ts',
  })]),
});

const comparisonRecord = Object.freeze({
  baseline: Object.freeze({ runId: 'run-a' }),
  candidate: Object.freeze({ runId: 'run-b' }),
  rows: Object.freeze([]),
  sampleSize: 3,
  summary: Object.freeze({ comparable: 0, nonComparable: 0, reliability: 0, smoke: 0 }),
}) as unknown as EvalComparison;

class RecordingService implements EvalRouteService {
  readonly calls: unknown[] = [];
  failure: unknown;
  /** Holds a run open until its request signal aborts, so cancellation is observable. */
  pending = false;

  async compare(baseRunId: string, candidateRunId: string): Promise<EvalComparison> {
    this.calls.push({ baseRunId, candidateRunId, kind: 'compare' });
    if (this.failure !== undefined) throw this.failure;
    return comparisonRecord;
  }

  async list(): Promise<readonly EvalRunRecord[]> {
    this.calls.push({ kind: 'list' });
    if (this.failure !== undefined) throw this.failure;
    return Object.freeze([runRecord]);
  }

  async read(runId: string): Promise<EvalRunResult> {
    this.calls.push({ kind: 'read', runId });
    if (this.failure !== undefined) throw this.failure;
    return runResult;
  }

  async run(request: EvalRunRequest): Promise<EvalRunResult> {
    this.calls.push({
      caseIds: request.caseIds,
      kind: 'run',
      named: Object.keys(request).sort(),
      suites: request.suites,
      trials: request.trials,
    });
    if (this.failure !== undefined) throw this.failure;
    const signal = request.signal;
    if (this.pending && signal !== undefined) {
      await new Promise<void>((resolvePromise) => {
        if (signal.aborted) resolvePromise();
        else signal.addEventListener('abort', () => resolvePromise(), { once: true });
      });
    }
    return runResult;
  }

  async suites(): Promise<EvalSuiteListing> {
    this.calls.push({ kind: 'suites' });
    if (this.failure !== undefined) throw this.failure;
    return suiteListing;
  }
}

const startRoutes = async (service?: EvalRouteService): Promise<StartedRoutes> => {
  const routes = new EvalRoutes({ authorize, ...(service === undefined ? {} : { service }) });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const diagnostic = error as Partial<{ code: string; message: string; status: number }>;
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.writeHead(diagnostic.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        diagnostic: {
          code: diagnostic.code ?? 'AB8007',
          message: diagnostic.message ?? 'Request could not be completed.',
        },
      }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => {
      routes.close();
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
    },
    routes,
    url: `http://127.0.0.1:${address.port}`,
  });
};

it('leaves every non-eval request to the rest of the foreground server', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const response = await fetch(`${started.url}/api/hooks`, { headers });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('');
  } finally {
    await started.close();
  }
});

it('lists discovered suites and recorded runs over the same session guard', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const suites = await fetch(`${started.url}/api/evals/suites`, { headers });
    const runs = await fetch(`${started.url}/api/evals/runs`, { headers });

    expect(suites.status).toBe(200);
    await expect(suites.json()).resolves.toEqual({ ...suiteListing });
    expect(runs.status).toBe(200);
    await expect(runs.json()).resolves.toEqual({ runs: [{ ...runRecord }] });
    expect(service.calls).toEqual([{ kind: 'suites' }, { kind: 'list' }]);
  } finally {
    await started.close();
  }
});

it('rejects an unauthorized eval request before it reaches the service', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const response = await fetch(`${started.url}/api/evals/suites`, { headers: { origin: 'http://127.0.0.1:4567' } });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8004' } });
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('starts a deterministic run from a suite, case, and trial selection only', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const response = await fetch(`${started.url}/api/evals/runs`, {
      body: JSON.stringify({ caseIds: ['reads-result'], suites: ['review-change'], trials: 2 }),
      headers,
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: { ...runResult } });
    expect(service.calls).toEqual([{
      caseIds: ['reads-result'],
      kind: 'run',
      named: ['caseIds', 'signal', 'suites', 'trials'],
      suites: ['review-change'],
      trials: 2,
    }]);
  } finally {
    await started.close();
  }
});

it('never lets a browser name an artifact, harness, or filesystem path', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    for (const body of [
      { artifact: '/tmp/artifact' },
      { harness: 'claude' },
      { runsDir: '../escape' },
      { trials: 0 },
      { trials: '2' },
      { caseIds: 'reads-result' },
      { suites: [''] },
    ]) {
      const response = await fetch(`${started.url}/api/evals/runs`, {
        body: JSON.stringify(body),
        headers,
        method: 'POST',
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8072' } });
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('reads one recorded run by its identifier', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const response = await fetch(`${started.url}/api/evals/runs/run-a`, { headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: { ...runResult } });
    expect(service.calls).toEqual([{ kind: 'read', runId: 'run-a' }]);
  } finally {
    await started.close();
  }
});

it('refuses a traversing or unknown eval route path', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    for (const path of ['/api/evals', '/api/evals/runs/run-a/trials', '/api/evals/runs/%2e%2e', '/api/evals/runs/%zz']) {
      const response = await fetch(`${started.url}${path}`, { headers });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8070' } });
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('answers each service refusal with one fixed browser-facing sentence', async () => {
  const expectations: readonly (readonly [EvalServiceError, string, number])[] = Object.freeze([
    [new EvalServiceError('EVAL_HARNESS_UNSUPPORTED', '/projects/demo has no claude harness'), 'AB8075', 422],
    [new EvalServiceError('EVAL_SELECTION_EMPTY', '/projects/demo/evals matched nothing'), 'AB8076', 422],
    [new EvalServiceError('EVAL_TARGET_MISSING', '/projects/demo/dist lacks claude'), 'AB8077', 422],
    [new EvalServiceError('EVAL_TRIALS_INVALID', '/projects/demo rejected 900 trials'), 'AB8072', 400],
    [new EvalServiceError('EVAL_RUN_NOT_FOUND', '/projects/demo/.agent-bundle/runs/run-b'), 'AB8074', 404],
  ]);
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    for (const [failure, code, status] of expectations) {
      service.failure = failure;
      const response = await fetch(`${started.url}/api/evals/runs`, {
        body: JSON.stringify({}),
        headers,
        method: 'POST',
      });

      expect(response.status).toBe(status);
      const body = await response.json() as { readonly diagnostic: { readonly code: string; readonly message: string } };
      expect(body.diagnostic.code).toBe(code);
      expect(body.diagnostic.message).not.toContain('/projects/demo');
    }
  } finally {
    await started.close();
  }
});

it('reports an unexpected service failure without leaking it', async () => {
  const service = new RecordingService();
  service.failure = new Error('/projects/demo/.agent-bundle exploded');
  const started = await startRoutes(service);
  try {
    const response = await fetch(`${started.url}/api/evals/suites`, { headers });

    expect(response.status).toBe(502);
    const body = await response.json() as { readonly diagnostic: { readonly code: string; readonly message: string } };
    expect(body.diagnostic.code).toBe('AB8073');
    expect(body.diagnostic.message).not.toContain('exploded');
  } finally {
    await started.close();
  }
});

it('refuses a method the eval routes do not accept', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const suites = await fetch(`${started.url}/api/evals/suites`, { headers, method: 'POST' });
    const run = await fetch(`${started.url}/api/evals/runs/run-a`, { headers, method: 'DELETE' });

    expect(suites.status).toBe(405);
    expect(run.status).toBe(405);
    await expect(suites.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8007' } });
  } finally {
    await started.close();
  }
});

it('requires a JSON body to start a run', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const unsupported = await fetch(`${started.url}/api/evals/runs`, {
      body: '{}',
      headers: { origin: headers.origin, 'x-agent-bundle-session': headers['x-agent-bundle-session'] },
      method: 'POST',
    });
    const malformed = await fetch(`${started.url}/api/evals/runs`, { body: '{', headers, method: 'POST' });

    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8009' } });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8001' } });
  } finally {
    await started.close();
  }
});

it('reports missing and closed eval routes distinctly', async () => {
  const withoutService = await startRoutes();
  try {
    const response = await fetch(`${withoutService.url}/api/evals/suites`, { headers });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8071' } });
  } finally {
    await withoutService.close();
  }

  const started = await startRoutes(new RecordingService());
  try {
    started.routes.close();
    const response = await fetch(`${started.url}/api/evals/suites`, { headers });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8071' } });
  } finally {
    await started.close();
  }
});

it('aborts an in-flight run when the routes close', async () => {
  const service = new RecordingService();
  service.pending = true;
  const started = await startRoutes(service);
  try {
    const pending = fetch(`${started.url}/api/evals/runs`, { body: JSON.stringify({}), headers, method: 'POST' });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    started.routes.close();

    await expect(pending.then((response) => response.status)).resolves.toBe(200);
  } finally {
    await started.close();
  }
});


it('compares two runs and rejects a smuggled or incomplete comparison query', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const compared = await fetch(`${started.url}/api/evals/comparisons?base=run-a&candidate=run-b`, { headers });
    expect(compared.status).toBe(200);
    await expect(compared.json()).resolves.toEqual({ comparison: comparisonRecord });
    expect(service.calls).toEqual([{ baseRunId: 'run-a', candidateRunId: 'run-b', kind: 'compare' }]);

    for (const query of ['', '?base=run-a', '?candidate=run-b', '?base=&candidate=run-b', '?base=run-a&candidate=run-b&artifact=/tmp/x']) {
      const rejected = await fetch(`${started.url}/api/evals/comparisons${query}`, { headers });
      expect(rejected.status).toBe(400);
    }
    expect(service.calls).toHaveLength(1);
  } finally {
    await started.close();
  }
});
