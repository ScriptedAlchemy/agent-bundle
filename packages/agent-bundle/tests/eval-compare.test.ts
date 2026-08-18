import { expect, it } from '@rstest/core';

import {
  compareEvalRuns,
  EvalComparisonError,
  evalReliabilityMinimumTrials,
  type EvalComparableRow,
  type EvalComparisonRow,
  type EvalComparisonSide,
  type EvalNonComparableRow,
} from '../src/eval/compare.ts';
import type { EvalRunRecord, EvalTrialRecord } from '../src/eval/run-store.ts';

const evidence = Object.freeze({
  mcp: Object.freeze({ calls: Object.freeze([]), level: 'unavailable' as const }),
  process: Object.freeze({ exitCode: 0, level: 'observed' as const, timedOut: false }),
  scripts: Object.freeze({ level: 'observed' as const, results: Object.freeze({}) }),
  skillActivation: Object.freeze({ activated: Object.freeze([]), level: 'observed' as const }),
});

const run = (id: string, overrides: Partial<EvalRunRecord> = {}): EvalRunRecord => Object.freeze({
  agentBundleVersion: '0.1.0',
  artifact: Object.freeze({
    manifestPath: 'artifacts/target/agent-bundle.manifest.json',
    source: 'run-owned' as const,
    targetDigests: Object.freeze({ claude: 'a'.repeat(64) }),
  }),
  createdAt: '2026-08-17T12:00:00.000Z',
  harness: 'deterministic',
  id,
  projectRevision: 'b'.repeat(64),
  schemaVersion: 1 as const,
  ...overrides,
});

const trial = (overrides: Partial<EvalTrialRecord> = {}): EvalTrialRecord => Object.freeze({
  assertions: Object.freeze([]),
  caseDigest: 'case-digest-1',
  caseId: 'direct-review',
  completedAt: '2026-08-17T12:00:01.000Z',
  durationMs: 1000,
  evidence,
  fixtureDigest: 'fixture-digest-1',
  host: 'claude',
  id: 'trial-0',
  model: 'sonnet',
  outcome: 'pass' as const,
  prompt: 'Review the staged diff.',
  rawArtifacts: Object.freeze([]),
  schemaVersion: 1 as const,
  startedAt: '2026-08-17T12:00:00.000Z',
  targetDigest: 'target-baseline',
  trialIndex: 0,
  ...overrides,
});

const trials = (
  outcomes: readonly EvalTrialRecord['outcome'][],
  overrides: Partial<EvalTrialRecord> = {},
): readonly EvalTrialRecord[] => Object.freeze(outcomes.map((outcome, index) =>
  trial({ id: `trial-${index}`, outcome, trialIndex: index, ...overrides })));

const side = (
  id: string,
  sideTrials: readonly EvalTrialRecord[],
  overrides: Partial<EvalComparisonSide> = {},
): EvalComparisonSide => ({ run: run(id), trials: sideTrials, ...overrides });

const comparable = (row: EvalComparisonRow | undefined): EvalComparableRow => {
  if (row === undefined || !row.comparable) throw new Error('Expected a comparable row.');
  return row;
};

const nonComparable = (row: EvalComparisonRow | undefined): EvalNonComparableRow => {
  if (row === undefined || row.comparable) throw new Error('Expected a non-comparable row.');
  return row;
};

it('reports the actual k/n with pass@k and pass^k for an aligned condition', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'fail', 'pass', 'fail'])),
    candidate: side('run-candidate', trials(['pass', 'pass', 'pass', 'fail'], { targetDigest: 'target-candidate' })),
  });

  expect(comparison.baselineRunId).toBe('run-base');
  expect(comparison.candidateRunId).toBe('run-candidate');
  expect(comparison.sampleSize).toBe(evalReliabilityMinimumTrials);
  const row = comparable(comparison.rows[0]);
  expect(row).toMatchObject({ caseId: 'direct-review', comparable: true, evidence: 'reliability', host: 'claude', model: 'sonnet' });
  expect(row.baseline).toMatchObject({ fail: 2, passRate: 0.5, passes: 2, runId: 'run-base', trials: 4 });
  expect(row.candidate).toMatchObject({ fail: 1, passRate: 0.75, passes: 3, runId: 'run-candidate', trials: 4 });
  // pass@3 over 2 of 4 = 1 - C(2,3)/C(4,3) = 1; pass^3 over 2 of 4 = C(2,3)/C(4,3) = 0.
  expect(row.baseline.reliability).toEqual({ passAtK: 1, passPowerK: 0, sampleSize: 3 });
  // pass^3 over 3 of 4 = C(3,3)/C(4,3) = 0.25.
  expect(row.candidate.reliability).toEqual({ passAtK: 1, passPowerK: 0.25, sampleSize: 3 });
  expect(row.delta).toMatchObject({ passRate: 0.25, passes: 1, reliability: { passAtK: 0, passPowerK: 0.25, sampleSize: 3 }, trials: 0 });
  expect(comparison.summary).toEqual({ comparable: 1, nonComparable: 0, reliability: 1, smoke: 0 });
});

it('labels one or two trials as smoke evidence instead of reporting a reliability number', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'fail'])),
    candidate: side('run-candidate', trials(['pass', 'pass'])),
  });

  const row = comparable(comparison.rows[0]);
  expect(row.evidence).toBe('smoke');
  expect(row.baseline.evidence).toBe('smoke');
  expect(row.baseline.reliability).toBeUndefined();
  expect(row.candidate.reliability).toBeUndefined();
  expect(row.delta.reliability).toBeUndefined();
  // The observed counts remain, because k/n is a record of what ran, not a reliability claim.
  expect(row.baseline).toMatchObject({ passes: 1, trials: 2 });
  expect(comparison.summary).toEqual({ comparable: 1, nonComparable: 0, reliability: 0, smoke: 1 });
});

it('keeps a smoke baseline from lending reliability to a candidate that has enough trials', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'pass'])),
    candidate: side('run-candidate', trials(['pass', 'pass', 'fail'])),
  });

  const row = comparable(comparison.rows[0]);
  expect(row.evidence).toBe('smoke');
  expect(row.baseline.reliability).toBeUndefined();
  expect(row.candidate.reliability).toMatchObject({ sampleSize: 2 });
  expect(row.delta.reliability).toBeUndefined();
});

it.each([
  ['case-mismatch', { caseDigest: 'case-digest-2' }],
  ['fixture-mismatch', { fixtureDigest: 'fixture-digest-2' }],
  ['model-mismatch', { model: 'opus' }],
] as const)('labels a %s condition non-comparable and never folds it into a delta', (code, overrides) => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'pass', 'pass'])),
    candidate: side('run-candidate', trials(['fail', 'fail', 'fail'], overrides)),
  });

  const row = nonComparable(comparison.rows[0]);
  expect(row.comparable).toBe(false);
  expect('delta' in row).toBe(false);
  expect(row.causes.map((cause) => cause.code)).toContain(code);
  expect(row.causes[0]?.message).toContain('not comparable');
  expect(row.baseline).toMatchObject({ passes: 3, trials: 3 });
  expect(row.candidate).toMatchObject({ passes: 0, trials: 3 });
  expect(comparison.summary).toEqual({ comparable: 0, nonComparable: 1, reliability: 0, smoke: 0 });
});

it('labels a host CLI version, invocation, grader version, or harness mismatch non-comparable', () => {
  const baselineTrials = trials(['pass', 'pass', 'pass']);
  const candidateTrials = trials(['pass', 'pass', 'pass']);
  const causeCodes = (candidate: EvalComparisonSide): readonly string[] =>
    nonComparable(compareEvalRuns({ baseline: side('run-base', baselineTrials, {
      graderVersions: { outcome: '1.0.0' },
      hostCliVersions: { claude: '2.4.0' },
      invocations: { 'direct-review': 'automatic' },
    }), candidate }).rows[0]).causes.map((cause) => cause.code);

  expect(causeCodes(side('run-candidate', candidateTrials, {
    graderVersions: { outcome: '1.0.0' },
    hostCliVersions: { claude: '2.5.0' },
    invocations: { 'direct-review': 'automatic' },
  }))).toEqual(['host-cli-version-mismatch']);
  expect(causeCodes(side('run-candidate', candidateTrials, {
    graderVersions: { outcome: '1.0.0' },
    hostCliVersions: { claude: '2.4.0' },
    invocations: { 'direct-review': 'explicit' },
  }))).toEqual(['invocation-mismatch']);
  expect(causeCodes(side('run-candidate', candidateTrials, {
    graderVersions: { outcome: '2.0.0' },
    hostCliVersions: { claude: '2.4.0' },
    invocations: { 'direct-review': 'automatic' },
  }))).toEqual(['grader-versions-mismatch']);
  expect(causeCodes({
    graderVersions: { outcome: '1.0.0' },
    hostCliVersions: { claude: '2.4.0' },
    invocations: { 'direct-review': 'automatic' },
    run: run('run-candidate', { harness: 'claude-native' }),
    trials: candidateTrials,
  })).toEqual(['harness-mismatch']);
});

it('reports a facet neither run recorded as unverified rather than as an alignment', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'pass', 'pass'])),
    candidate: side('run-candidate', trials(['pass', 'pass', 'pass']), { hostCliVersions: { claude: '2.4.0' } }),
  });

  expect(nonComparable(comparison.rows[0]).causes.map((cause) => cause.code)).toEqual(['host-cli-version-mismatch']);

  const unverified = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'pass', 'pass'])),
    candidate: side('run-candidate', trials(['pass', 'pass', 'pass'])),
  });

  expect(comparable(unverified.rows[0]).unverifiedFacets).toEqual(['grader-versions', 'host-cli-version', 'invocation']);
});

it('labels a condition that only one run recorded as non-comparable', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', [
      ...trials(['pass', 'pass', 'pass']),
      ...trials(['fail'], { caseId: 'retired-case' }),
    ]),
    candidate: side('run-candidate', [
      ...trials(['pass', 'pass', 'pass']),
      ...trials(['pass'], { caseId: 'new-case' }),
    ]),
  });

  expect(comparison.rows.map((row) => [row.caseId, row.comparable])).toEqual([
    ['direct-review', true],
    ['new-case', false],
    ['retired-case', false],
  ]);
  const missingBaseline = nonComparable(comparison.rows[1]);
  expect(missingBaseline.causes[0]?.code).toBe('missing-baseline');
  expect(missingBaseline.baseline).toBeUndefined();
  expect(missingBaseline.model).toBe('sonnet');
  expect(nonComparable(comparison.rows[2]).causes[0]?.code).toBe('missing-candidate');
  expect(comparison.summary).toEqual({ comparable: 1, nonComparable: 2, reliability: 1, smoke: 0 });
});

it('keeps harness failures out of k/n and reports a condition without gradable trials', () => {
  const harnessFailure = Object.freeze({
    code: 'EVAL_TRACE_UNAVAILABLE' as const,
    message: 'The harness could not read the trace.',
    stage: 'trace' as const,
  });
  const comparison = compareEvalRuns({
    baseline: side('run-base', [
      ...trials(['pass', 'pass', 'pass']),
      trial({ harnessFailure, id: 'trial-3', outcome: 'inconclusive', trialIndex: 3 }),
    ]),
    candidate: side('run-candidate', trials(['inconclusive', 'inconclusive'], { harnessFailure })),
  });

  const row = nonComparable(comparison.rows[0]);
  expect(row.baseline).toMatchObject({ harnessFailures: 1, passes: 3, trials: 3 });
  expect(row.candidate).toMatchObject({ harnessFailures: 2, passes: 0, trials: 0 });
  expect(row.causes.map((cause) => cause.code)).toEqual(['no-gradable-trials']);
});

it('separates an inconclusive condition from a failing one', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'inconclusive', 'pass'])),
    candidate: side('run-candidate', trials(['pass', 'fail', 'pass'])),
  });

  const row = comparable(comparison.rows[0]);
  expect(row.baseline).toMatchObject({ fail: 0, inconclusive: 1, outcome: 'inconclusive' });
  expect(row.candidate).toMatchObject({ fail: 1, inconclusive: 0, outcome: 'fail' });
});

it('totals duration and recorded usage over gradable trials only', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', [
      trial({ durationMs: 1000, id: 'trial-0', trialIndex: 0 }),
      trial({ durationMs: 3000, id: 'trial-1', trialIndex: 1 }),
      trial({ durationMs: 2000, id: 'trial-2', trialIndex: 2 }),
    ], { usage: { 'trial-0': { inputTokens: 100, outputTokens: 20 }, 'trial-1': { inputTokens: 200, outputTokens: 30 } } }),
    candidate: side('run-candidate', trials(['pass', 'pass', 'pass'], { durationMs: 1000 })),
  });

  const row = comparable(comparison.rows[0]);
  expect(row.baseline).toMatchObject({ durationMs: 6000, meanDurationMs: 2000 });
  expect(row.baseline.usage).toEqual({ inputTokens: 300, outputTokens: 50, recordedTrials: 2, totalTokens: 350 });
  expect(row.candidate.usage).toBeUndefined();
  expect(row.delta.meanDurationMs).toBe(-1000);
  expect(row.delta.totalTokens).toBeUndefined();
});

it('rejects a sample size that cannot express pass@k', () => {
  const sides = {
    baseline: side('run-base', trials(['pass'])),
    candidate: side('run-candidate', trials(['pass'])),
  };

  expect(() => compareEvalRuns({ ...sides, sampleSize: 0 })).toThrow(EvalComparisonError);
  expect(() => compareEvalRuns({ ...sides, sampleSize: 1.5 })).toThrow(/positive integer/u);
  expect(() => compareEvalRuns({
    baseline: side('run-base', trials(['pass']), { usage: { 'trial-0': { inputTokens: -1, outputTokens: 0 } } }),
    candidate: sides.candidate,
  })).toThrow(EvalComparisonError);
});

it('freezes the comparison so a route cannot mutate a recorded result', () => {
  const comparison = compareEvalRuns({
    baseline: side('run-base', trials(['pass', 'pass', 'pass'])),
    candidate: side('run-candidate', trials(['pass', 'pass', 'pass'])),
  });

  expect(Object.isFrozen(comparison)).toBe(true);
  expect(Object.isFrozen(comparison.rows)).toBe(true);
  expect(Object.isFrozen(comparison.rows[0])).toBe(true);
  expect(Object.isFrozen(comparable(comparison.rows[0]).baseline)).toBe(true);
});
