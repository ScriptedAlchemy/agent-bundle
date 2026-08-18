import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { EvalRunResult, EvalSuiteListing } from '../../agent-bundle/src/dev/eval-service.ts';
import type { EvalRunRecord, EvalTrialRecord } from '../../agent-bundle/src/eval/run-store.ts';
import { EvalClient } from '../src/evals/eval-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { evalRunSelectionFor, evalRunViewFor } from '../src/evals/evals-model.ts';
import {
  EvalRunControls,
  EvalRunReport,
  EvalsPage,
  EvalsRequestLifecycle,
  eventsForActiveEvalRun,
  openEvalRun,
  startEvalRun,
} from '../src/evals/evals-page.tsx';

const targetDigest = 'c'.repeat(64);

const listing: EvalSuiteListing = {
  diagnostics: [],
  suites: [{
    cases: [
      {
        assertions: [{ id: 'outcome:0123456789abcdef', kind: 'outcome' }],
        digest: 'b'.repeat(64),
        hosts: ['portable'],
        id: 'reads-result',
        invocation: { mode: 'automatic' },
        prompt: 'Report the highest-risk regression.',
        trials: 2,
      },
      {
        assertions: [{ id: 'skill-activation:0123456789abcdef', kind: 'skill-activation' }],
        digest: 'e'.repeat(64),
        hosts: ['portable'],
        id: 'unbound-activation',
        invocation: { mode: 'explicit', skill: 'review' },
        prompt: 'Invoke the review Skill.',
        trials: 1,
      },
    ],
    digest: 'd'.repeat(64),
    name: 'review-change',
    sourcePath: 'evals/review.eval.ts',
  }],
};

const runRecord: EvalRunRecord = {
  agentBundleVersion: '0.1.0',
  artifact: { manifestPath: 'agent-bundle.manifest.json', source: 'run-owned', targetDigests: { portable: targetDigest } },
  completedAt: '2026-08-17T00:00:02.000Z',
  createdAt: '2026-08-17T00:00:00.000Z',
  harness: 'deterministic',
  id: '20260817t000000000z-abcdef01',
  projectRevision: 'd'.repeat(64),
  schemaVersion: 1,
  summary: { cases: 2, fail: 1, inconclusive: 1, pass: 1, trials: 3 },
};

const trial = (overrides: Partial<EvalTrialRecord>): EvalTrialRecord => ({
  assertions: [{
    assertionId: 'outcome:0123456789abcdef',
    detail: 'The fixture recorded risk high.',
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
  targetDigest,
  trialIndex: 0,
  ...overrides,
});

const result: EvalRunResult = {
  aggregates: [],
  diagnostics: [],
  run: runRecord,
  trials: [
    trial({}),
    trial({
      assertions: [{
        assertionId: 'skill-activation:0123456789abcdef',
        detail: 'The harness recorded "unavailable" evidence but this assertion requires at least "inferred".',
        evidence: 'unavailable',
        kind: 'skill-activation',
        outcome: 'inconclusive',
      }],
      caseId: 'unbound-activation',
      id: 'portable-1-activation',
      outcome: 'inconclusive',
    }),
    trial({
      assertions: [{
        assertionId: 'outcome:fedcba9876543210',
        detail: 'The fixture did not record risk low.',
        evidence: 'observed',
        kind: 'outcome',
        outcome: 'fail',
      }],
      caseId: 'wrong-result',
      id: 'portable-1-wrong',
      outcome: 'fail',
      pluginFailure: { code: 'EVAL_PLUGIN_ASSERTION_FAILED', message: 'At least one assertion failed.' },
    }),
  ],
};

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status: 200,
});

const client = (fetch: typeof globalThis.fetch): EvalClient => new EvalClient({
  foreground: new ForegroundRouteClient({ fetch }),
});

const view = (result_: EvalRunResult | undefined) =>
  evalRunViewFor({ listing, result: result_, selectedSuite: 'review-change' });

it('renders each trial outcome with the exact target digest of the artifact it exercised', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(result) }));

  expect(markup).toContain('Passed');
  expect(markup).toContain('Failed');
  expect(markup).toContain('Inconclusive');
  expect(markup).toContain(targetDigest);
  expect(markup).toContain('portable-1-activation');
  expect(markup).toContain('The fixture did not record risk low.');
  expect(markup).toContain('EVAL_PLUGIN_ASSERTION_FAILED');
});

it('presents an inconclusive trial distinctly from a failing trial', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(result) }));

  expect(markup).toContain('eval-outcome eval-outcome-inconclusive');
  expect(markup).toContain('eval-outcome eval-outcome-fail');
  expect(markup).toContain('eval-outcome eval-outcome-pass');
  expect(markup).toContain('recorded no defect');
  expect(markup).toContain('requires at least');
});

it('summarizes passed, failed, and inconclusive counts separately', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(result) }));

  expect(markup).toContain('1 passed');
  expect(markup).toContain('1 failed');
  expect(markup).toContain('1 inconclusive');
});

it('renders the persisted timeline, server evidence channels, host/model matrix, and raw evidence controls', () => {
  const evidenceView = evalRunViewFor({
    events: [
      { kind: 'run.started', payload: { trials: 3 }, schemaVersion: 1, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' },
      { kind: 'trial.completed', payload: { outcome: 'pass' }, schemaVersion: 1, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' },
    ],
    listing,
    result,
    selectedSuite: 'review-change',
  });

  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: evidenceView }));

  expect(markup).toContain('Durable event timeline');
  expect(markup).toContain('#1');
  expect(markup).toContain('run.started');
  expect(markup).toContain('Host / model matrix');
  expect(markup).toContain('Evidence channels');
  expect(markup).toContain('unavailable evidence');
  expect(markup).toContain('Raw evidence');
  expect(markup).toContain('evidence.json');
});

it('does not paint held prior-run events while a replacement run waits for replay', () => {
  const priorRunEvents = Object.freeze([
    Object.freeze({ kind: 'run.started', payload: Object.freeze({ trials: 3 }), schemaVersion: 1, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }),
  ]);

  expect(eventsForActiveEvalRun('run-b', 'run-a', priorRunEvents)).toEqual([]);
  expect(eventsForActiveEvalRun('run-a', 'run-a', priorRunEvents)).toEqual(priorRunEvents);
});

it('lists the cases of the selected suite before any run exists', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(undefined) }));

  expect(markup).toContain('reads-result');
  expect(markup).toContain('unbound-activation');
  expect(markup).toContain('Report the highest-risk regression.');
  expect(markup).toContain('explicit · review');
  expect(markup).toContain('Select an authored suite');
});

it('renders unsupported configuration diagnostics as a visible alert', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, {
    view: evalRunViewFor({
      listing: {
        diagnostics: [{
          code: 'AB9000',
          message: 'Model-backed eval semantic grader configuration is not supported yet and was ignored.',
          severity: 'warning',
        }],
        suites: listing.suites,
      },
      result: undefined,
      selectedSuite: undefined,
    }),
  }));

  expect(markup).toContain('role="alert"');
  expect(markup).toContain('AB9000');
  expect(markup).toContain('not supported yet');
});

it('renders the suite, trial, and recorded run controls of a project that declares suites', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunControls, {
    busy: false,
    onOpenRun: () => undefined,
    onSelectRun: () => undefined,
    onSelectSuite: () => undefined,
    onStartRun: () => undefined,
    onTrialsChange: () => undefined,
    openableRun: runRecord.id,
    recorded: [runRecord],
    runnable: true,
    trials: '2',
    view: view(undefined),
  }));

  expect(markup).toContain('id="eval-suite"');
  expect(markup).toContain('id="eval-trials"');
  expect(markup).toContain('id="eval-run"');
  expect(markup).toContain('Run deterministic suite');
  expect(markup).toContain('Open recorded run');
  expect(markup).toContain('evals/review.eval.ts');
});

it('marks an invalid trial count instead of letting the run start', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunControls, {
    busy: false,
    onOpenRun: () => undefined,
    onSelectRun: () => undefined,
    onSelectSuite: () => undefined,
    onStartRun: () => undefined,
    onTrialsChange: () => undefined,
    openableRun: undefined,
    recorded: [],
    runnable: false,
    trials: 'two',
    view: view(undefined),
  }));

  expect(markup).toContain('aria-invalid="true"');
  expect(markup).toContain('Trials must be a whole number between 1 and 100.');
  expect(markup).toContain('Run deterministic suite</button>');
  expect(markup).not.toContain('id="eval-run"');
});

it('states that no eval evidence exists before the suites have loaded', () => {
  const evalClient = client(async () => response(listing));
  const markup = renderToStaticMarkup(createElement(EvalsPage, { client: evalClient }));

  expect(markup).toContain('Looking for authored eval suites');
  expect(markup).not.toContain('id="eval-suite"');
});

it('starts a run from the selected suite and trial count only', async () => {
  const bodies: unknown[] = [];
  const evalClient = client(async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      return response({ run: result });
    });
  const selection = evalRunSelectionFor(view(undefined), '2');
  if (selection === undefined) throw new Error('Expected a runnable selection.');

  const started = await startEvalRun(evalClient, selection);

  expect(bodies).toEqual([{ suites: ['review-change'], trials: 2 }]);
  expect(started.run.id).toBe(runRecord.id);
  expect(started.trials).toHaveLength(3);
});

it('reopens a recorded run by identifier without restarting it', async () => {
  const requests: string[] = [];
  const evalClient = client(async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      return response({ run: result });
    });

  const reopened = await openEvalRun(evalClient, runRecord.id);

  expect(requests).toEqual([`GET /api/evals/runs/${runRecord.id}`]);
  expect(reopened.run.summary).toEqual(runRecord.summary);
});

it('supersedes a held initial run listing before a post-action refresh and aborts all work on navigation', () => {
  const lifecycle = new EvalsRequestLifecycle();
  const initialRuns = lifecycle.begin('runs');
  const action = lifecycle.begin('action');
  const refreshedRuns = lifecycle.begin('runs');

  expect(initialRuns.signal.aborted).toBe(true);
  expect(lifecycle.isCurrent(initialRuns)).toBe(false);
  expect(lifecycle.isCurrent(action)).toBe(true);
  expect(lifecycle.isCurrent(refreshedRuns)).toBe(true);

  lifecycle.invalidate();

  expect(action.signal.aborted).toBe(true);
  expect(refreshedRuns.signal.aborted).toBe(true);
  expect(lifecycle.isCurrent(action)).toBe(false);
  expect(lifecycle.isCurrent(refreshedRuns)).toBe(false);
});
