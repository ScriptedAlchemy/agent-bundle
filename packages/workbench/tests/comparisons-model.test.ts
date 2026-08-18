import { expect, it } from '@rstest/core';

import type {
  EvalComparableRow,
  EvalComparison,
  EvalConditionMetrics,
  EvalNonComparableRow,
} from '../../agent-bundle/src/eval/compare.ts';
import type { EvalRunRecord } from '../../agent-bundle/src/eval/run-store.ts';
import {
  comparisonMetricCellFor,
  comparisonMatrixRowFor,
  comparisonRunOptionsFor,
  comparisonsViewFor,
} from '../src/comparisons/comparisons-model.ts';

const run = (id: string, createdAt: string): EvalRunRecord => ({
  agentBundleVersion: '0.1.0',
  artifact: { manifestPath: 'artifacts/target/agent-bundle.manifest.json', source: 'run-owned', targetDigests: { claude: 'a'.repeat(64) } },
  createdAt,
  harness: 'deterministic',
  id,
  projectRevision: 'b'.repeat(64),
  schemaVersion: 1,
});

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
  provenance: {
    hostCliVersion: '2.1.232',
    invocation: 'automatic',
    semanticGrader: 'none',
  },
  reliability: { passAtK: 1, passPowerK: 0.25, sampleSize: 3 },
  runId: 'run-base',
  trials: 4,
  ...overrides,
});

const comparableRow = (overrides: Partial<EvalComparableRow> = {}): EvalComparableRow => ({
  baseline: metrics(),
  candidate: metrics({ fail: 0, outcome: 'pass', passRate: 1, passes: 4, reliability: { passAtK: 1, passPowerK: 1, sampleSize: 3 }, runId: 'run-candidate' }),
  caseId: 'direct-review',
  comparable: true,
  delta: { meanDurationMs: 0, passRate: 0.25, passes: 1, reliability: { passAtK: 0, passPowerK: 0.75, sampleSize: 3 }, trials: 0 },
  evidence: 'reliability',
  host: 'claude',
  model: 'sonnet',
  unverifiedFacets: [],
  ...overrides,
});

const nonComparableRow: EvalNonComparableRow = {
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
};

const comparison = (overrides: Partial<EvalComparison> = {}): EvalComparison => ({
  baselineRunId: 'run-base',
  candidateRunId: 'run-candidate',
  rows: [comparableRow(), nonComparableRow],
  sampleSize: 3,
  summary: { comparable: 1, nonComparable: 1, reliability: 1, smoke: 0 },
  ...overrides,
});

const runs = [run('run-base', '2026-08-17T12:00:00.000Z'), run('run-candidate', '2026-08-17T13:00:00.000Z')];

it('labels each recorded run with its harness and creation time', () => {
  expect(comparisonRunOptionsFor(runs)).toEqual([
    { key: 'run-base', label: 'run-base · deterministic · 2026-08-17T12:00:00.000Z' },
    { key: 'run-candidate', label: 'run-candidate · deterministic · 2026-08-17T13:00:00.000Z' },
  ]);
});

it('shows the actual k/n beside pass@k and pass^k', () => {
  const cell = comparisonMetricCellFor(metrics());

  expect(cell.kOverN).toBe('3/4');
  expect(cell.passRate).toBe('75.0%');
  expect(cell.passAtK).toBe('100.0% (k=3)');
  expect(cell.passPowerK).toBe('25.0% (k=3)');
  expect(cell.evidenceLabel).toBe('Reliability · 4 trials');
  expect(cell.provenance).toBe('CLI 2.1.232 · Invocation automatic · Semantic grader none');
});

it('states smoke evidence in place of a reliability number', () => {
  const cell = comparisonMetricCellFor(metrics({ evidence: 'smoke', passRate: 0.5, passes: 1, reliability: undefined, trials: 2 }));

  expect(cell.kOverN).toBe('1/2');
  expect(cell.passAtK).toBe('Smoke evidence');
  expect(cell.passPowerK).toBe('Smoke evidence');
  expect(cell.evidenceLabel).toBe('Smoke evidence · 2 trials');
});

it('keeps an inconclusive condition distinct from a failing one', () => {
  expect(comparisonMetricCellFor(metrics({ fail: 0, inconclusive: 1, outcome: 'inconclusive' }))).toMatchObject({
    outcome: 'inconclusive',
    outcomeLabel: 'Inconclusive',
  });
  expect(comparisonMetricCellFor(metrics())).toMatchObject({ outcome: 'fail', outcomeLabel: 'Fail' });
});

it('reports recorded usage and mean duration, or states that usage was not recorded', () => {
  expect(comparisonMetricCellFor(metrics({
    usage: { inputTokens: 300, outputTokens: 50, recordedTrials: 2, totalTokens: 350 },
  }))).toMatchObject({ meanDuration: '1000 ms', usage: '350 tokens · 2 of 4 trials' });
  expect(comparisonMetricCellFor(metrics()).usage).toBe('Not recorded');
});

it('renders a signed delta only for a comparable row', () => {
  const row = comparisonMatrixRowFor(comparableRow());

  expect(row).toMatchObject({ comparable: true, key: 'direct-review/claude', model: 'sonnet', reasons: [], unverifiedFacets: [] });
  expect(row.delta).toEqual({
    meanDuration: '0 ms',
    passAtK: '0.0 pts',
    passPowerK: '+75.0 pts',
    passRate: '+25.0 pts',
    passes: '+1',
    usage: 'Not recorded',
  });
  expect(row.evidenceNote).toBeUndefined();
});

it('marks a smoke row as evidence rather than a reliability claim', () => {
  const row = comparisonMatrixRowFor(comparableRow({
    baseline: metrics({ evidence: 'smoke', reliability: undefined, trials: 2 }),
    delta: { meanDurationMs: -250.5, passRate: 0.25, passes: 1, trials: 2 },
    evidence: 'smoke',
  }));

  expect(row.evidenceNote).toContain('not a reliability claim');
  expect(row.delta).toMatchObject({ meanDuration: '-251 ms', passAtK: 'Smoke evidence', passPowerK: 'Smoke evidence' });
});

it('renders a non-comparable row with its reason instead of a delta', () => {
  const row = comparisonMatrixRowFor(nonComparableRow);

  expect(row.comparable).toBe(false);
  expect(row.delta).toBeUndefined();
  expect(row.model).toBe('Not aligned');
  expect(row.reasons).toEqual([{
    code: 'host-cli-version-mismatch',
    detail: '2.4.0 → 2.5.0',
    label: 'Host CLI version',
  }]);
});

it('names a condition only one run recorded', () => {
  const row = comparisonMatrixRowFor({
    candidate: metrics({ runId: 'run-candidate' }),
    caseId: 'new-case',
    causes: [{
      baseline: 'absent',
      candidate: 'present',
      code: 'missing-baseline',
      message: 'The baseline run has no trial for this condition, so this condition is not comparable.',
    }],
    comparable: false,
    host: 'claude',
    model: 'sonnet',
  });

  expect(row.baseline).toBeUndefined();
  expect(row.model).toBe('sonnet');
  expect(row.reasons[0]?.label).toBe('Missing in baseline');
});

it('asks for two runs before a comparison can be aligned', () => {
  const view = comparisonsViewFor({ baseRunId: undefined, candidateRunId: undefined, comparison: undefined, runs: runs.slice(0, 1) });

  expect(view.state).toBe('insufficient-runs');
  expect(view.summary).toContain('two recorded runs');
  expect(view.rows).toEqual([]);
});

it('defaults the baseline to the oldest run and the candidate to the newest', () => {
  const view = comparisonsViewFor({ baseRunId: undefined, candidateRunId: undefined, comparison: undefined, runs });

  expect(view.state).toBe('ready');
  expect(view.base?.key).toBe('run-base');
  expect(view.candidate?.key).toBe('run-candidate');
  expect(view.summary).toContain('Select');
});

it('honours the selected baseline and candidate and summarises the aligned matrix', () => {
  const view = comparisonsViewFor({
    baseRunId: 'run-candidate',
    candidateRunId: 'run-base',
    comparison: comparison(),
    runs,
  });

  expect(view.state).toBe('compared');
  expect(view.base?.key).toBe('run-candidate');
  expect(view.candidate?.key).toBe('run-base');
  expect(view.rows.map((row) => row.key)).toEqual(['direct-review/claude', 'skill-activation/claude']);
  expect(view.summary).toBe('1 comparable condition, 1 non-comparable, 0 with smoke evidence only.');
});

it('states that two runs share no condition instead of showing an empty matrix', () => {
  const view = comparisonsViewFor({
    baseRunId: 'run-base',
    candidateRunId: 'run-candidate',
    comparison: comparison({ rows: [], summary: { comparable: 0, nonComparable: 0, reliability: 0, smoke: 0 } }),
    runs,
  });

  expect(view.state).toBe('empty');
  expect(view.summary).toContain('no condition');
});
