import type {
  EvalAlignmentFacet,
  EvalComparison,
  EvalComparisonEvidence,
  EvalComparisonRow,
  EvalConditionMetrics,
  EvalNonComparableReason,
} from '../../../agent-bundle/src/eval/compare.ts';
import type { EvalRunRecord } from '../../../agent-bundle/src/eval/run-store.ts';
import type { EvalAssertionOutcome } from '../../../agent-bundle/src/eval/types.ts';

export type ComparisonsState = 'compared' | 'empty' | 'insufficient-runs' | 'ready';

export interface ComparisonRunOption {
  readonly key: string;
  readonly label: string;
}

export interface ComparisonMetricCell {
  readonly evidence: EvalComparisonEvidence;
  readonly evidenceLabel: string;
  /** The actual passes over gradable trials, shown beside the estimated pass@k and pass^k. */
  readonly kOverN: string;
  readonly meanDuration: string;
  readonly outcome: EvalAssertionOutcome;
  readonly outcomeLabel: string;
  readonly passAtK: string;
  readonly passPowerK: string;
  readonly passRate: string;
  readonly runId: string;
  readonly usage: string;
}

export interface ComparisonDeltaCell {
  readonly meanDuration: string;
  readonly passAtK: string;
  readonly passPowerK: string;
  readonly passRate: string;
  readonly passes: string;
  readonly usage: string;
}

export interface ComparisonReason {
  readonly code: EvalNonComparableReason;
  readonly detail: string;
  readonly label: string;
}

export interface ComparisonMatrixRow {
  readonly baseline: ComparisonMetricCell | undefined;
  readonly candidate: ComparisonMetricCell | undefined;
  readonly caseId: string;
  readonly comparable: boolean;
  readonly delta: ComparisonDeltaCell | undefined;
  readonly evidenceNote: string | undefined;
  readonly host: string;
  readonly key: string;
  readonly model: string;
  readonly reasons: readonly ComparisonReason[];
  /** Facets neither run recorded, so their alignment is unverified rather than established. */
  readonly unverifiedFacets: readonly EvalAlignmentFacet[];
}

export interface ComparisonsViewOptions {
  readonly baseRunId: string | undefined;
  readonly candidateRunId: string | undefined;
  readonly comparison: EvalComparison | undefined;
  readonly runs: readonly EvalRunRecord[];
}

export interface ComparisonsView {
  readonly base: ComparisonRunOption | undefined;
  readonly candidate: ComparisonRunOption | undefined;
  readonly rows: readonly ComparisonMatrixRow[];
  readonly runs: readonly ComparisonRunOption[];
  readonly state: ComparisonsState;
  readonly summary: string;
}

const noFacets: readonly EvalAlignmentFacet[] = Object.freeze([]);

const noReasons: readonly ComparisonReason[] = Object.freeze([]);

const noRows: readonly ComparisonMatrixRow[] = Object.freeze([]);

const smokeLabel = 'Smoke evidence';

const smokeNote =
  'Smoke evidence: fewer than three trials on an aligned condition, so this row is an observation, not a reliability claim.';

const outcomeLabels: Readonly<Record<EvalAssertionOutcome, string>> = Object.freeze({
  fail: 'Fail',
  inconclusive: 'Inconclusive',
  pass: 'Pass',
});

const reasonLabels: Readonly<Record<EvalNonComparableReason, string>> = Object.freeze({
  'case-mismatch': 'Case definition',
  'fixture-mismatch': 'Fixture digest',
  'grader-versions-mismatch': 'Grader versions',
  'harness-mismatch': 'Harness',
  'host-cli-version-mismatch': 'Host CLI version',
  'invocation-mismatch': 'Invocation',
  'missing-baseline': 'Missing in baseline',
  'missing-candidate': 'Missing in candidate',
  'model-mismatch': 'Pinned model',
  'no-gradable-trials': 'No gradable trial',
});

const sign = (value: number): string => (value > 0 ? '+' : '');

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const points = (value: number): string => `${sign(value)}${(value * 100).toFixed(1)} pts`;

const duration = (value: number): string =>
  `${value < 0 ? '-' : ''}${Math.round(Math.abs(value))} ms`;

export const comparisonRunOptionsFor = (runs: readonly EvalRunRecord[]): readonly ComparisonRunOption[] =>
  Object.freeze(runs.map((run) => Object.freeze({
    key: run.id,
    label: `${run.id} · ${run.harness} · ${run.createdAt}`,
  })));

/** A smoke condition states its evidence where a reliability estimate would otherwise be printed. */
export const comparisonMetricCellFor = (metrics: EvalConditionMetrics): ComparisonMetricCell => Object.freeze({
  evidence: metrics.evidence,
  evidenceLabel: `${metrics.evidence === 'smoke' ? smokeLabel : 'Reliability'} · ${metrics.trials} trials`,
  kOverN: `${metrics.passes}/${metrics.trials}`,
  meanDuration: duration(metrics.meanDurationMs),
  outcome: metrics.outcome,
  outcomeLabel: outcomeLabels[metrics.outcome],
  passAtK: metrics.reliability === undefined
    ? smokeLabel
    : `${percent(metrics.reliability.passAtK)} (k=${metrics.reliability.sampleSize})`,
  passPowerK: metrics.reliability === undefined
    ? smokeLabel
    : `${percent(metrics.reliability.passPowerK)} (k=${metrics.reliability.sampleSize})`,
  passRate: percent(metrics.passRate),
  runId: metrics.runId,
  usage: metrics.usage === undefined
    ? 'Not recorded'
    : `${metrics.usage.totalTokens} tokens · ${metrics.usage.recordedTrials} of ${metrics.trials} trials`,
});

export const comparisonMatrixRowFor = (row: EvalComparisonRow): ComparisonMatrixRow => {
  const delta = row.comparable ? row.delta : undefined;
  return Object.freeze({
    baseline: row.baseline === undefined ? undefined : comparisonMetricCellFor(row.baseline),
    candidate: row.candidate === undefined ? undefined : comparisonMetricCellFor(row.candidate),
    caseId: row.caseId,
    comparable: row.comparable,
    delta: delta === undefined ? undefined : Object.freeze({
      meanDuration: `${sign(delta.meanDurationMs)}${duration(delta.meanDurationMs)}`,
      passAtK: delta.reliability === undefined ? smokeLabel : points(delta.reliability.passAtK),
      passPowerK: delta.reliability === undefined ? smokeLabel : points(delta.reliability.passPowerK),
      passRate: points(delta.passRate),
      passes: `${sign(delta.passes)}${delta.passes}`,
      usage: delta.totalTokens === undefined ? 'Not recorded' : `${sign(delta.totalTokens)}${delta.totalTokens} tokens`,
    }),
    evidenceNote: row.comparable && row.evidence === 'smoke' ? smokeNote : undefined,
    host: row.host,
    key: `${row.caseId}/${row.host}`,
    model: row.comparable ? row.model : row.model ?? 'Not aligned',
    reasons: row.comparable ? noReasons : Object.freeze(row.causes.map((cause) => Object.freeze({
      code: cause.code,
      detail: `${cause.baseline} → ${cause.candidate}`,
      label: reasonLabels[cause.code],
    }))),
    unverifiedFacets: row.comparable ? row.unverifiedFacets : noFacets,
  });
};

const conditions = (count: number): string => `${count} comparable condition${count === 1 ? '' : 's'}`;

const summaryFor = (state: ComparisonsState, comparison: EvalComparison | undefined): string => {
  if (state === 'insufficient-runs') return 'At least two recorded runs are needed before a comparison can be aligned.';
  if (state === 'empty') return 'These two runs share no condition, so there is nothing to align.';
  if (state === 'compared' && comparison !== undefined) {
    return `${conditions(comparison.summary.comparable)}, ${comparison.summary.nonComparable} non-comparable, ${comparison.summary.smoke} with smoke evidence only.`;
  }
  return 'Select a baseline run and a candidate run to align them condition by condition.';
};

/** Derives every Comparisons page section from the recorded runs and the latest aligned comparison. */
export const comparisonsViewFor = (options: ComparisonsViewOptions): ComparisonsView => {
  const runs = comparisonRunOptionsFor(options.runs);
  const comparison = options.comparison;
  const state: ComparisonsState = runs.length < 2 ? 'insufficient-runs'
    : comparison === undefined ? 'ready'
      : comparison.rows.length === 0 ? 'empty'
        : 'compared';
  return Object.freeze({
    base: runs.find((option) => option.key === options.baseRunId) ?? runs[0],
    candidate: runs.find((option) => option.key === options.candidateRunId) ?? runs[runs.length - 1],
    rows: state === 'compared' && comparison !== undefined
      ? Object.freeze(comparison.rows.map(comparisonMatrixRowFor))
      : noRows,
    runs,
    state,
    summary: summaryFor(state, comparison),
  });
};
