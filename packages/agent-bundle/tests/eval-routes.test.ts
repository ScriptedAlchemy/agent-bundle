import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { expect, it } from '@rstest/core';

import { EvalRoutes, type EvalRouteService } from '../src/dev/eval-routes.ts';
import {
  EvalServiceError,
  type EvalArtifactReader,
  type EvalRunRequest,
  type EvalRunResult,
  type EvalSuiteListing,
} from '../src/dev/eval-service.ts';
import type { EvalComparison } from '../src/eval/compare.ts';
import type { EvalRunEvent, EvalRunRecord, EvalTrialRecord } from '../src/eval/run-store.ts';

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
  artifactCloseCalls = 0;
  artifactCloseFailure: unknown;
  artifactOpening = false;
  artifactOpeningStarted: (() => void) | undefined;
  artifactOpeningRelease: (() => void) | undefined;
  artifactReadRelease: (() => void) | undefined;
  eventSubscriptionCloseCalls = 0;
  eventSubscriptionCloseFailure: unknown;
  eventSubscriptionOpening = false;
  eventSubscriptionOpeningRelease: (() => void) | undefined;
  eventSubscriptionOpeningStarted: (() => void) | undefined;
  failure: unknown;
  holdArtifact = false;
  /** Holds a run open until its request signal aborts, so cancellation is observable. */
  pending = false;

  async compare(baseRunId: string, candidateRunId: string): Promise<EvalComparison> {
    this.calls.push({ baseRunId, candidateRunId, kind: 'compare' });
    if (this.failure !== undefined) throw this.failure;
    return comparisonRecord;
  }

  async events(runId: string, afterSequence: number) {
    this.calls.push({ afterSequence, kind: 'events', runId });
    if (this.failure !== undefined) throw this.failure;
    const events = Object.freeze([
      Object.freeze({ kind: 'run.started', payload: Object.freeze({}), schemaVersion: 1 as const, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }),
      Object.freeze({ kind: 'trial.completed', payload: Object.freeze({}), schemaVersion: 1 as const, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' }),
    ]);
    return Object.freeze({
      cursor: Object.freeze({ afterSequence: 2 }),
      events: Object.freeze(events.filter((event) => event.sequence > afterSequence)),
    });
  }

  async list(): Promise<readonly EvalRunRecord[]> {
    this.calls.push({ kind: 'list' });
    if (this.failure !== undefined) throw this.failure;
    return Object.freeze([runRecord]);
  }

  async openArtifact(runId: string, ref: string): Promise<EvalArtifactReader> {
    this.calls.push({ kind: 'artifact', ref, runId });
    if (this.failure !== undefined) throw this.failure;
    if (this.artifactOpening) {
      this.artifactOpeningStarted?.();
      await new Promise<void>((resolvePromise) => { this.artifactOpeningRelease = resolvePromise; });
    }
    const bytes = Buffer.from('{"evidence":true}\n');
    return Object.freeze({
      close: async () => {
        this.artifactCloseCalls += 1;
        if (this.artifactCloseFailure !== undefined) throw this.artifactCloseFailure;
      },
      digest: 'f'.repeat(64),
      filename: 'evidence.json',
      read: (start = 0, end = bytes.length - 1) => {
        if (!this.holdArtifact) return Readable.from([bytes.subarray(start, end + 1)]);
        const stream = new Readable({ read: () => undefined });
        this.artifactReadRelease = () => stream.push(null);
        return stream;
      },
      ref,
      size: bytes.length,
    });
  }

  async read(runId: string): Promise<EvalRunResult> {
    this.calls.push({ kind: 'read', runId });
    if (this.failure !== undefined) throw this.failure;
    return runResult;
  }

  async subscribeEvents(runId: string, afterSequence: number) {
    if (this.eventSubscriptionOpening) {
      this.eventSubscriptionOpeningStarted?.();
      await new Promise<void>((resolvePromise) => { this.eventSubscriptionOpeningRelease = resolvePromise; });
    }
    const replay = await this.events(runId, afterSequence);
    return Object.freeze({
      activate: (listener: (event: EvalRunEvent) => void): void => {
        listener(Object.freeze({ kind: 'run.completed', payload: Object.freeze({}), schemaVersion: 1 as const, sequence: 3, timestamp: '2026-08-17T00:00:02.000Z' }));
      },
      close: (): void => {
        this.eventSubscriptionCloseCalls += 1;
        if (this.eventSubscriptionCloseFailure !== undefined) throw this.eventSubscriptionCloseFailure;
      },
      replay,
    });
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

it('replays persisted eval events from one canonical cursor over the foreground guard', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const replay = await fetch(`${started.url}/api/evals/runs/run-a/events?after=1`, { headers });
    const malformed = await fetch(`${started.url}/api/evals/runs/run-a/events?after=01`, { headers });

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replay: { cursor: { afterSequence: 2 }, events: [{ sequence: 2 }] } });
    expect(malformed.status).toBe(400);
    expect(service.calls).toEqual([{ afterSequence: 1, kind: 'events', runId: 'run-a' }]);
  } finally {
    await started.close();
  }
});

it('writes a bounded NDJSON replay from the requested eval event cursor', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const stream = await fetch(`${started.url}/api/evals/runs/run-a/stream?after=1`, { headers });

    expect(stream.status).toBe(200);
    expect(stream.headers.get('cache-control')).toBe('no-store');
    expect(stream.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    await expect(stream.text()).resolves.toBe([
      JSON.stringify({ kind: 'trial.completed', payload: {}, schemaVersion: 1, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' }),
      JSON.stringify({ kind: 'run.completed', payload: {}, schemaVersion: 1, sequence: 3, timestamp: '2026-08-17T00:00:02.000Z' }),
      '',
    ].join('\n'));
    expect(service.calls).toEqual([{ afterSequence: 1, kind: 'events', runId: 'run-a' }]);
  } finally {
    await started.close();
  }
});

it('keeps route close pending through event-stream admission and closes the late subscription once', async () => {
  const service = new RecordingService();
  service.eventSubscriptionOpening = true;
  const opening = new Promise<void>((resolvePromise) => { service.eventSubscriptionOpeningStarted = resolvePromise; });
  const started = await startRoutes(service);
  let response: Response | undefined;
  try {
    const pending = fetch(`${started.url}/api/evals/runs/run-a/stream`, { headers });
    await opening;
    let closeSettled = false;
    const closing = started.routes.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    service.eventSubscriptionOpeningRelease?.();
    await closing;
    response = await pending;

    expect(response.status).toBe(503);
    expect(service.eventSubscriptionCloseCalls).toBe(1);
  } finally {
    service.eventSubscriptionOpeningRelease?.();
    await response?.text().catch(() => undefined);
    await started.close().catch(() => undefined);
  }
});

it('closes an event subscription resolved after its peer disconnects during admission', async () => {
  const service = new RecordingService();
  service.eventSubscriptionOpening = true;
  const opening = new Promise<void>((resolvePromise) => { service.eventSubscriptionOpeningStarted = resolvePromise; });
  const started = await startRoutes(service);
  try {
    const controller = new AbortController();
    const pending = fetch(`${started.url}/api/evals/runs/run-a/stream`, { headers, signal: controller.signal });
    await opening;
    controller.abort();
    service.eventSubscriptionOpeningRelease?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));

    expect(service.eventSubscriptionCloseCalls).toBe(1);
    await started.routes.close();
  } finally {
    service.eventSubscriptionOpeningRelease?.();
    await started.close().catch(() => undefined);
  }
});

it('retains a late event-subscription cleanup failure in the stable route close aggregate', async () => {
  const service = new RecordingService();
  service.eventSubscriptionOpening = true;
  service.eventSubscriptionCloseFailure = new Error('subscription close failed');
  const opening = new Promise<void>((resolvePromise) => { service.eventSubscriptionOpeningStarted = resolvePromise; });
  const started = await startRoutes(service);
  let response: Response | undefined;
  try {
    const pending = fetch(`${started.url}/api/evals/runs/run-a/stream`, { headers });
    await opening;
    const closing = started.routes.close();
    service.eventSubscriptionOpeningRelease?.();

    await expect(closing).rejects.toThrow('Eval route readers could not close.');
    response = await pending;
    expect(response.status).toBe(502);
    expect(service.eventSubscriptionCloseCalls).toBe(1);
  } finally {
    service.eventSubscriptionOpeningRelease?.();
    await response?.text().catch(() => undefined);
    await started.close().catch(() => undefined);
  }
});

it('serves an opaque persisted artifact as a safe attachment with one byte range', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const ref = 'artifacts/portable-1/evidence.json';
    const opaque = Buffer.from(ref).toString('base64url');
    const full = await fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, { headers });
    const range = await fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, {
      headers: { ...headers, range: 'bytes=1-3' },
    });
    const head = await fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, {
      headers,
      method: 'HEAD',
    });
    const invalid = await fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, {
      headers: { ...headers, range: 'bytes=0-1,3-4' },
    });

    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('cache-control')).toBe('no-store');
    expect(full.headers.get('content-disposition')).toBe('attachment; filename="evidence.json"');
    expect(full.headers.get('etag')).toBe(`"${'f'.repeat(64)}"`);
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(full.text()).resolves.toBe('{"evidence":true}\n');
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 1-3/18');
    await expect(range.text()).resolves.toBe('"ev');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('18');
    expect(head.headers.get('content-type')).toBe('application/json; charset=utf-8');
    await expect(head.text()).resolves.toBe('');
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */18');
    expect(service.calls).toEqual([
      { kind: 'artifact', ref, runId: 'run-a' },
      { kind: 'artifact', ref, runId: 'run-a' },
      { kind: 'artifact', ref, runId: 'run-a' },
      { kind: 'artifact', ref, runId: 'run-a' },
    ]);
    expect(service.artifactCloseCalls).toBe(4);
  } finally {
    await started.close();
  }
});

it('drains an active artifact reader through one reentrant route close promise', async () => {
  const service = new RecordingService();
  service.holdArtifact = true;
  const started = await startRoutes(service);
  try {
    const ref = 'artifacts/portable-1/evidence.json';
    const opaque = Buffer.from(ref).toString('base64url');
    const response = await fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, { headers });

    expect(response.status).toBe(200);
    const first = started.routes.close();
    const second = started.routes.close();
    expect(first).toBe(second);
    await first;
    expect(service.artifactCloseCalls).toBe(1);
  } finally {
    await started.close();
  }
});

it('does not let route close settle while an artifact reader is still being admitted', async () => {
  const service = new RecordingService();
  service.artifactOpening = true;
  service.holdArtifact = true;
  const opening = new Promise<void>((resolvePromise) => { service.artifactOpeningStarted = resolvePromise; });
  const started = await startRoutes(service);
  let response: Response | undefined;
  try {
    const ref = 'artifacts/portable-1/evidence.json';
    const opaque = Buffer.from(ref).toString('base64url');
    const pending = fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, { headers });
    await opening;
    const closing = started.routes.close();
    service.artifactOpeningRelease?.();
    await closing;
    response = await pending;

    expect(service.artifactCloseCalls).toBe(1);
    expect(response.status).toBe(503);
  } finally {
    service.artifactReadRelease?.();
    await response?.text().catch(() => undefined);
    await started.close();
  }
});

it('closes an artifact resolved after its peer disconnects during admission', async () => {
  const service = new RecordingService();
  service.artifactOpening = true;
  const opening = new Promise<void>((resolvePromise) => { service.artifactOpeningStarted = resolvePromise; });
  const started = await startRoutes(service);
  try {
    const controller = new AbortController();
    const ref = 'artifacts/portable-1/evidence.json';
    const opaque = Buffer.from(ref).toString('base64url');
    const pending = fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, { headers, signal: controller.signal });
    await opening;
    controller.abort();
    service.artifactOpeningRelease?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(service.artifactCloseCalls).toBe(1);
    await expect(started.routes.close()).resolves.toBeUndefined();
  } finally {
    await started.close().catch(() => undefined);
  }
});

it('tracks a peer-closed artifact reader failure for the stable route close aggregate', async () => {
  const service = new RecordingService();
  service.artifactCloseFailure = new Error('reader close failed');
  service.holdArtifact = true;
  const started = await startRoutes(service);
  const unhandled: unknown[] = [];
  const observe = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', observe);
  try {
    const ref = 'artifacts/portable-1/evidence.json';
    const opaque = Buffer.from(ref).toString('base64url');
    const response = await fetch(`${started.url}/api/evals/runs/run-a/artifacts/${opaque}`, { headers });
    await response.body?.cancel();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));

    await expect(started.routes.close()).rejects.toThrow('Eval route readers could not close.');
    expect(service.artifactCloseCalls).toBe(1);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', observe);
    await started.close().catch(() => undefined);
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
    [new EvalServiceError('EVAL_SEMANTIC_GRADER_UNSUPPORTED', '/projects/demo has semantic grading on codex'), 'AB8083', 422],
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

it('describes AB8075 as an unknown or unsupported harness', async () => {
  const service = new RecordingService();
  service.failure = new EvalServiceError('EVAL_HARNESS_UNSUPPORTED', '/projects/demo has no gemini harness');
  const started = await startRoutes(service);
  try {
    const response = await fetch(`${started.url}/api/evals/runs`, {
      body: JSON.stringify({}),
      headers,
      method: 'POST',
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      diagnostic: { code: 'AB8075', message: 'The requested eval harness is unknown or unsupported.' },
    });
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
