import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { EvalComparison, EvalConditionMetrics } from '../../agent-bundle/src/eval/compare.ts';
import type { EvalRunRecord } from '../../agent-bundle/src/eval/run-store.ts';
import { ComparisonClient } from '../src/comparisons/comparison-client.ts';
import {
  ComparisonControls,
  ComparisonMatrix,
  ComparisonsPage,
  loadComparisonRuns,
  runComparison,
} from '../src/comparisons/comparisons-page.tsx';
import { comparisonsViewFor } from '../src/comparisons/comparisons-model.ts';
import { EvalClient } from '../src/evals/eval-client.ts';

const run = (id: string, createdAt: string): EvalRunRecord => ({
  agentBundleVersion: '0.1.0',
  artifact: { manifestPath: 'artifacts/target/agent-bundle.manifest.json', source: 'run-owned', targetDigests: { claude: 'a'.repeat(64) } },
  createdAt,
  harness: 'deterministic',
  id,
  projectRevision: 'b'.repeat(64),
  schemaVersion: 1,
});

const runs = [run('run-base', '2026-08-17T12:00:00.000Z'), run('run-candidate', '2026-08-17T13:00:00.000Z')];

const metrics = (overrides: Partial<EvalConditionMetrics> = {}): EvalConditionMetrics => ({
  durationMs: 4000,
  evidence: 'reliability',
  fail: 1,
  harnessFailures: 0,
  inconclusive: 0,
  meanDurationMs: 1000,
  outcome: 'fail',
  passRate: 0.75,
  passes: 3,
  reliability: { passAtK: 1, passPowerK: 0.25, sampleSize: 3 },
  runId: 'run-base',
  trials: 4,
  ...overrides,
});

const comparison: EvalComparison = {
  baselineRunId: 'run-base',
  candidateRunId: 'run-candidate',
  rows: [
    {
      baseline: metrics({ fail: 0, inconclusive: 1, outcome: 'inconclusive' }),
      candidate: metrics({ runId: 'run-candidate' }),
      caseId: 'direct-review',
      comparable: true,
      delta: { meanDurationMs: 0, passRate: 0, passes: 0, reliability: { passAtK: 0, passPowerK: 0, sampleSize: 3 }, trials: 0 },
      evidence: 'reliability',
      host: 'claude',
      model: 'sonnet',
      unverifiedFacets: ['grader-versions'],
    },
    {
      baseline: metrics({ evidence: 'smoke', passRate: 0.5, passes: 1, reliability: undefined, trials: 2 }),
      candidate: metrics({ evidence: 'smoke', passRate: 1, passes: 2, reliability: undefined, runId: 'run-candidate', trials: 2 }),
      caseId: 'smoke-case',
      comparable: true,
      delta: { meanDurationMs: 0, passRate: 0.5, passes: 1, trials: 0 },
      evidence: 'smoke',
      host: 'claude',
      model: 'sonnet',
      unverifiedFacets: [],
    },
    {
      baseline: metrics(),
      candidate: metrics({ runId: 'run-candidate' }),
      caseId: 'skill-activation',
      causes: [{
        baseline: '2.4.0',
        candidate: '2.5.0',
        code: 'host-cli-version-mismatch',
        message: 'Baseline host CLI version "2.4.0" and candidate host CLI version "2.5.0" do not align, so this condition is not comparable.',
      }],
      comparable: false,
      host: 'claude',
    },
  ],
  sampleSize: 3,
  summary: { comparable: 2, nonComparable: 1, reliability: 1, smoke: 1 },
};

const view = comparisonsViewFor({ baseRunId: 'run-base', candidateRunId: 'run-candidate', comparison, runs });

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status: 200,
});

const stubFetch = (calls: string[], body: unknown): typeof fetch => async (input) => {
  const url = String(input);
  if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
  calls.push(url);
  return response(body);
};

it('shows the actual k/n beside pass@k and pass^k in the matrix', () => {
  const markup = renderToStaticMarkup(createElement(ComparisonMatrix, { view }));

  expect(markup).toContain('pass@k');
  expect(markup).toContain('pass^k');
  expect(markup).toContain('3/4');
  expect(markup).toContain('100.0% (k=3)');
  expect(markup).toContain('25.0% (k=3)');
  expect(markup).toContain('direct-review');
  expect(markup).toContain('sonnet');
});

it('keeps an inconclusive condition visually distinct from a failing one', () => {
  const markup = renderToStaticMarkup(createElement(ComparisonMatrix, { view }));

  expect(markup).toContain('comparison-outcome--inconclusive');
  expect(markup).toContain('comparison-outcome--fail');
  expect(markup).toContain('Inconclusive');
  expect(markup).toContain('Fail');
});

it('labels a smoke row as evidence instead of printing a reliability number', () => {
  const markup = renderToStaticMarkup(createElement(ComparisonMatrix, { view }));

  expect(markup).toContain('comparison-row--smoke');
  expect(markup).toContain('not a reliability claim');
  expect(markup).toContain('Smoke evidence');
  expect(markup).toContain('1/2');
});

it('renders a non-comparable row as non-comparable with its reason and no delta', () => {
  const markup = renderToStaticMarkup(createElement(ComparisonMatrix, { view }));

  expect(markup).toContain('comparison-row--non-comparable');
  expect(markup).toContain('Not comparable');
  expect(markup).toContain('Host CLI version');
  expect(markup).toContain('2.4.0 → 2.5.0');
  expect(markup).toContain('Not aligned');
});

it('names the facets no run recorded so an alignment is never overstated', () => {
  const markup = renderToStaticMarkup(createElement(ComparisonMatrix, { view }));

  expect(markup).toContain('grader-versions');
});

it('states that a matrix without rows has nothing to align', () => {
  const empty = comparisonsViewFor({
    baseRunId: 'run-base',
    candidateRunId: 'run-candidate',
    comparison: { ...comparison, rows: [], summary: { comparable: 0, nonComparable: 0, reliability: 0, smoke: 0 } },
    runs,
  });
  const markup = renderToStaticMarkup(createElement(ComparisonMatrix, { view: empty }));

  expect(markup).toContain('share no condition');
  expect(markup).not.toContain('<table');
});

it('offers a baseline and candidate selection with a compare action', () => {
  const markup = renderToStaticMarkup(createElement(ComparisonControls, {
    busy: false,
    onCompare: () => undefined,
    onSelectBase: () => undefined,
    onSelectCandidate: () => undefined,
    view,
  }));

  expect(markup).toContain('id="comparison-base"');
  expect(markup).toContain('id="comparison-candidate"');
  expect(markup).toContain('run-base · deterministic · 2026-08-17T12:00:00.000Z');
  expect(markup).toContain('Compare runs');
});

it('renders no comparison controls until two runs are recorded', () => {
  const comparisonClient = new ComparisonClient({ fetch: async () => { throw new Error('The page compares through its own effect.'); } });
  const evalClient = new EvalClient({ fetch: async () => { throw new Error('The page lists runs through its own effect.'); } });
  const markup = renderToStaticMarkup(createElement(ComparisonsPage, { comparisonClient, evalClient }));

  expect(markup).toContain('At least two recorded runs');
  expect(markup).not.toContain('id="comparison-base"');
  expect(markup).not.toContain('Compare runs');
});

it('delegates run loading to EvalClient and the server comparison to ComparisonClient', async () => {
  const comparisonCalls: string[] = [];
  const evalCalls: string[] = [];
  const comparisonClient = new ComparisonClient({ fetch: stubFetch(comparisonCalls, { comparison }) });
  const evalClient = new EvalClient({ fetch: stubFetch(evalCalls, { runs }) });

  await expect(loadComparisonRuns(evalClient)).resolves.toMatchObject([{ id: 'run-base' }, { id: 'run-candidate' }]);
  const result = await runComparison(comparisonClient, 'run-base', 'run-candidate');

  expect(evalCalls).toEqual(['/api/evals/runs']);
  expect(comparisonCalls).toEqual(['/api/evals/comparisons?base=run-base&candidate=run-candidate']);
  expect(result.rows).toHaveLength(3);
  expect(result.summary).toMatchObject({ comparable: 2, nonComparable: 1 });
});
