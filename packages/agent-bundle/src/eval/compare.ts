import type { EvalRunRecord, EvalTrialRecord, EvalTrialProvenance, EvalTrialUsage } from './run-store.ts';
import type { EvalAssertionOutcome } from './types.ts';

/** Fewer trials than this is a smoke check, so no reliability number is reported for it. */
export const evalReliabilityMinimumTrials = 3;

export type EvalComparisonEvidence = 'reliability' | 'smoke';

/**
 * The facets that must align before a delta is allowed. The artifact target digest is
 * deliberately absent: it is the thing under comparison, not an alignment requirement.
 */
export type EvalAlignmentFacet =
  | 'case'
  | 'fixture'
  | 'harness'
  | 'host-cli-version'
  | 'invocation'
  | 'model'
  | 'semantic-grader-identity';

export type EvalNonComparableReason =
  | 'case-mismatch'
  | 'fixture-mismatch'
  | 'harness-mismatch'
  | 'host-cli-version-mismatch'
  | 'invocation-mismatch'
  | 'missing-baseline'
  | 'missing-candidate'
  | 'model-mismatch'
  | 'no-gradable-trials'
  | 'semantic-grader-identity-mismatch';

export type EvalComparisonErrorCode =
  | 'EVAL_COMPARISON_SAMPLE_INVALID'
  | 'EVAL_COMPARISON_USAGE_INVALID';

export class EvalComparisonError extends Error {
  readonly code: EvalComparisonErrorCode;

  constructor(code: EvalComparisonErrorCode, message: string) {
    super(message);
    this.name = 'EvalComparisonError';
    this.code = code;
  }
}

export type EvalRecordedUsage = EvalTrialUsage;

export interface EvalComparisonUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly recordedTrials: number;
  readonly totalTokens: number;
}

export interface EvalUnrecordedConditionSemanticGrader {
  readonly state: 'unrecorded';
}

/** Literal persisted alignment details for one condition side, without commands or filesystem paths. */
export interface EvalConditionProvenance {
  readonly hostCliVersion?: string;
  readonly invocation?: string;
  readonly semanticGrader?: string | EvalUnrecordedConditionSemanticGrader;
}

/** One side of a comparison, derived solely from its durable run and trial records. */
export interface EvalComparisonSide {
  readonly run: EvalRunRecord;
  readonly trials: readonly EvalTrialRecord[];
}

export interface EvalComparisonOptions {
  readonly baseline: EvalComparisonSide;
  readonly candidate: EvalComparisonSide;
  readonly sampleSize?: number;
}

/** Only a condition with reliability evidence carries pass@k and pass^k. */
export interface EvalReliability {
  readonly passAtK: number;
  readonly passPowerK: number;
  readonly sampleSize: number;
}

export interface EvalConditionMetrics {
  readonly durationMs: number;
  readonly evidence: EvalComparisonEvidence;
  readonly fail: number;
  readonly harnessFailures: number;
  readonly inconclusive: number;
  readonly meanDurationMs: number;
  readonly outcome: EvalAssertionOutcome;
  readonly passRate: number;
  readonly passes: number;
  readonly provenance: EvalConditionProvenance;
  readonly reliability?: EvalReliability;
  readonly runId: string;
  readonly trials: number;
  readonly usage?: EvalComparisonUsage;
}

export interface EvalComparisonDelta {
  readonly meanDurationMs: number;
  readonly passRate: number;
  readonly passes: number;
  readonly reliability?: EvalReliability;
  readonly totalTokens?: number;
  readonly trials: number;
}

export interface EvalNonComparableCause {
  readonly baseline: string;
  readonly candidate: string;
  readonly code: EvalNonComparableReason;
  readonly message: string;
}

export interface EvalComparableRow {
  readonly baseline: EvalConditionMetrics;
  readonly candidate: EvalConditionMetrics;
  readonly caseId: string;
  readonly comparable: true;
  readonly delta: EvalComparisonDelta;
  readonly evidence: EvalComparisonEvidence;
  readonly host: string;
  readonly model: string;
}

export interface EvalNonComparableRow {
  readonly baseline?: EvalConditionMetrics;
  readonly candidate?: EvalConditionMetrics;
  readonly caseId: string;
  readonly causes: readonly EvalNonComparableCause[];
  readonly comparable: false;
  readonly host: string;
  readonly model?: string;
}

export type EvalComparisonRow = EvalComparableRow | EvalNonComparableRow;

export interface EvalComparisonSummary {
  readonly comparable: number;
  readonly nonComparable: number;
  readonly reliability: number;
  readonly smoke: number;
}

export interface EvalComparison {
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly rows: readonly EvalComparisonRow[];
  readonly sampleSize: number;
  readonly summary: EvalComparisonSummary;
}

interface FacetValue {
  readonly mixed: boolean;
  readonly recorded: boolean;
  readonly value: string;
}

interface Condition {
  readonly caseId: string;
  readonly host: string;
  readonly side: EvalComparisonSide;
  readonly trials: readonly EvalTrialRecord[];
}

const alignmentFacets: readonly EvalAlignmentFacet[] = Object.freeze([
  'case',
  'fixture',
  'harness',
  'host-cli-version',
  'invocation',
  'model',
  'semantic-grader-identity',
]);

const facetLabels: Readonly<Record<EvalAlignmentFacet, string>> = Object.freeze({
  'case': 'case definition',
  'fixture': 'fixture digest',
  'harness': 'harness',
  'host-cli-version': 'host CLI version',
  'invocation': 'invocation',
  'model': 'pinned model',
  'semantic-grader-identity': 'semantic grader identity',
});

const facetReasons: Readonly<Record<EvalAlignmentFacet, EvalNonComparableReason>> = Object.freeze({
  'case': 'case-mismatch',
  'fixture': 'fixture-mismatch',
  'harness': 'harness-mismatch',
  'host-cli-version': 'host-cli-version-mismatch',
  'invocation': 'invocation-mismatch',
  'model': 'model-mismatch',
  'semantic-grader-identity': 'semantic-grader-identity-mismatch',
});

const unrecorded = 'unrecorded';
const unrecordedSemanticGrader = Object.freeze({ state: 'unrecorded' as const });

const round = (value: number, places: number): number => Number.parseFloat(value.toFixed(places));

const conditionKey = (caseId: string, host: string): string => `${caseId}\u0000${host}`;

const comparisonError = (code: EvalComparisonErrorCode, message: string): EvalComparisonError =>
  new EvalComparisonError(code, message);

const requireSampleSize = (value: number | undefined): number => {
  if (value === undefined) return evalReliabilityMinimumTrials;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw comparisonError(
      'EVAL_COMPARISON_SAMPLE_INVALID',
      'An eval comparison sample size must be a positive integer.',
    );
  }
  return value;
};

const requireUsage = (side: EvalComparisonSide): void => {
  for (const trial of side.trials) {
    const usage = trial.usage;
    if (usage === undefined) continue;
    if (
      !Number.isFinite(usage.inputTokens) || usage.inputTokens < 0 ||
      !Number.isFinite(usage.outputTokens) || usage.outputTokens < 0
    ) {
      throw comparisonError(
        'EVAL_COMPARISON_USAGE_INVALID',
        `Recorded usage for trial ${JSON.stringify(trial.id)} must count tokens as non-negative numbers.`,
      );
    }
  }
};

/**
 * The unbiased pass@k / pass^k ratio C(top, k) / C(bottom, k), evaluated as a product so that
 * a large trial count cannot overflow a factorial.
 */
const combinationRatio = (top: number, bottom: number, sampleSize: number): number => {
  if (sampleSize > bottom) return 0;
  let ratio = 1;
  for (let index = 0; index < sampleSize; index += 1) ratio *= (top - index) / (bottom - index);
  return ratio;
};

const outcomeFor = (fail: number, inconclusive: number): EvalAssertionOutcome => {
  if (fail > 0) return 'fail';
  return inconclusive > 0 ? 'inconclusive' : 'pass';
};

const usageFor = (gradable: readonly EvalTrialRecord[]): EvalComparisonUsage | undefined => {
  const recorded = gradable
    .map((trial) => trial.usage)
    .filter((usage): usage is EvalRecordedUsage => usage !== undefined);
  if (recorded.length === 0) return undefined;
  const inputTokens = recorded.reduce((total, usage) => total + usage.inputTokens, 0);
  const outputTokens = recorded.reduce((total, usage) => total + usage.outputTokens, 0);
  return Object.freeze({
    inputTokens,
    outputTokens,
    recordedTrials: recorded.length,
    totalTokens: inputTokens + outputTokens,
  });
};

const invocationIdentity = (provenance: EvalTrialProvenance): string => {
  const invocation = provenance.invocation;
  return invocation.skill === undefined ? invocation.mode : `${invocation.mode}:${invocation.skill}`;
};

const semanticGraderIdentity = (provenance: EvalTrialProvenance): string | undefined => {
  const semanticGrader = provenance.semanticGrader;
  return semanticGrader === null
    ? 'none'
    : 'state' in semanticGrader
      ? undefined
      : `${semanticGrader.id}@${semanticGrader.model}/${semanticGrader.contractRevision}`;
};

const recordedConditionValue = (values: readonly (string | undefined)[]): string | undefined => {
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
  return [...new Set(values as readonly string[])].sort((left, right) => left.localeCompare(right)).join(', ');
};

const conditionProvenanceFor = (condition: Condition): EvalConditionProvenance => {
  const hostCliVersion = recordedConditionValue(condition.trials.map((trial) => trial.provenance.hostCliVersion));
  const invocation = recordedConditionValue(condition.trials.map((trial) => invocationIdentity(trial.provenance)));
  const graders = condition.trials.map((trial) => trial.provenance.semanticGrader);
  const semanticGrader = graders.every((grader) => grader !== undefined && grader !== null && 'state' in grader)
    ? unrecordedSemanticGrader
    : recordedConditionValue(condition.trials.map((trial) => semanticGraderIdentity(trial.provenance)));
  return Object.freeze({
    ...(hostCliVersion === undefined ? {} : { hostCliVersion }),
    ...(invocation === undefined ? {} : { invocation }),
    ...(semanticGrader === undefined ? {} : { semanticGrader }),
  });
};

/** A harness failure is a defect in Agent Bundle, so it never enters the plugin's own k/n. */
const metricsFor = (condition: Condition, sampleSize: number): EvalConditionMetrics => {
  const gradable = condition.trials.filter((trial) => trial.harnessFailure === undefined);
  const harnessFailures = condition.trials.length - gradable.length;
  const fail = gradable.filter((trial) => trial.outcome === 'fail').length;
  const inconclusive = gradable.filter((trial) => trial.outcome === 'inconclusive').length;
  const passes = gradable.filter((trial) => trial.outcome === 'pass').length;
  const durationMs = gradable.reduce((total, trial) => total + trial.durationMs, 0);
  const trials = gradable.length;
  const evidence: EvalComparisonEvidence = trials >= evalReliabilityMinimumTrials ? 'reliability' : 'smoke';
  const effectiveSize = Math.min(sampleSize, trials);
  const usage = usageFor(gradable);
  return Object.freeze({
    durationMs,
    evidence,
    fail,
    harnessFailures,
    inconclusive,
    meanDurationMs: trials === 0 ? 0 : round(durationMs / trials, 3),
    outcome: outcomeFor(fail, inconclusive),
    passRate: trials === 0 ? 0 : round(passes / trials, 6),
    passes,
    provenance: conditionProvenanceFor(condition),
    ...(evidence === 'smoke' ? {} : {
      reliability: Object.freeze({
        passAtK: round(1 - combinationRatio(trials - passes, trials, effectiveSize), 6),
        passPowerK: round(combinationRatio(passes, trials, effectiveSize), 6),
        sampleSize: effectiveSize,
      }),
    }),
    runId: condition.side.run.id,
    trials,
    ...(usage === undefined ? {} : { usage }),
  });
};

const facetValue = (values: readonly (string | undefined)[]): FacetValue => {
  const recorded = values.every((value) => value !== undefined);
  const distinct = [...new Set(values.map((value) => value ?? unrecorded))].sort((left, right) => left.localeCompare(right));
  const first = distinct[0];
  return Object.freeze({
    mixed: distinct.length > 1,
    recorded,
    value: first === undefined ? unrecorded : distinct.join(', '),
  });
};

const facetsOf = (condition: Condition): Readonly<Record<EvalAlignmentFacet, FacetValue>> => Object.freeze({
  'case': facetValue(condition.trials.map((trial) => trial.caseDigest)),
  'fixture': facetValue(condition.trials.map((trial) => trial.fixtureDigest)),
  'harness': facetValue([condition.side.run.harness]),
  'host-cli-version': facetValue(condition.trials.map((trial) => trial.provenance.hostCliVersion)),
  'invocation': facetValue(condition.trials.map((trial) => invocationIdentity(trial.provenance))),
  'model': facetValue(condition.trials.map((trial) => trial.model)),
  'semantic-grader-identity': facetValue(condition.trials.map((trial) => semanticGraderIdentity(trial.provenance))),
});

const causeFor = (
  facet: EvalAlignmentFacet,
  baseline: FacetValue,
  candidate: FacetValue,
): EvalNonComparableCause => Object.freeze({
  baseline: baseline.value,
  candidate: candidate.value,
  code: facetReasons[facet],
  message: `Baseline ${facetLabels[facet]} ${JSON.stringify(baseline.value)} and candidate ${facetLabels[facet]} ${JSON.stringify(candidate.value)} do not align, so this condition is not comparable.`,
});

const missingCause = (
  code: 'missing-baseline' | 'missing-candidate',
): EvalNonComparableCause => Object.freeze({
  baseline: code === 'missing-baseline' ? 'absent' : 'present',
  candidate: code === 'missing-baseline' ? 'present' : 'absent',
  code,
  message: code === 'missing-baseline'
    ? 'The baseline run has no trial for this condition, so this condition is not comparable.'
    : 'The candidate run has no trial for this condition, so this condition is not comparable.',
});

const ungradableCause = (
  baseline: EvalConditionMetrics,
  candidate: EvalConditionMetrics,
): EvalNonComparableCause => Object.freeze({
  baseline: `${baseline.trials} gradable of ${baseline.trials + baseline.harnessFailures}`,
  candidate: `${candidate.trials} gradable of ${candidate.trials + candidate.harnessFailures}`,
  code: 'no-gradable-trials',
  message: 'A run recorded only harness failures for this condition, so this condition is not comparable.',
});

const deltaFor = (baseline: EvalConditionMetrics, candidate: EvalConditionMetrics): EvalComparisonDelta => {
  const baselineTotal = baseline.usage?.totalTokens;
  const candidateTotal = candidate.usage?.totalTokens;
  const completeUsage = baseline.trials === candidate.trials &&
    baseline.usage?.recordedTrials === baseline.trials && candidate.usage?.recordedTrials === candidate.trials;
  const reliability = baseline.reliability === undefined || candidate.reliability === undefined
    ? undefined
    : Object.freeze({
        passAtK: round(candidate.reliability.passAtK - baseline.reliability.passAtK, 6),
        passPowerK: round(candidate.reliability.passPowerK - baseline.reliability.passPowerK, 6),
        sampleSize: Math.min(baseline.reliability.sampleSize, candidate.reliability.sampleSize),
      });
  return Object.freeze({
    meanDurationMs: round(candidate.meanDurationMs - baseline.meanDurationMs, 3),
    passRate: round(candidate.passRate - baseline.passRate, 6),
    passes: candidate.passes - baseline.passes,
    ...(reliability === undefined ? {} : { reliability }),
    ...(baselineTotal === undefined || candidateTotal === undefined || !completeUsage
      ? {}
      : { totalTokens: candidateTotal - baselineTotal }),
    trials: candidate.trials - baseline.trials,
  });
};

const conditionsOf = (side: EvalComparisonSide): ReadonlyMap<string, Condition> => {
  const conditions = new Map<string, Omit<Condition, 'trials'> & { readonly trials: Condition['trials'][number][] }>();
  for (const trial of side.trials) {
    const key = conditionKey(trial.caseId, trial.host);
    const existing = conditions.get(key);
    if (existing === undefined) {
      conditions.set(key, { caseId: trial.caseId, host: trial.host, side, trials: [trial] });
      continue;
    }
    existing.trials.push(trial);
  }
  return conditions;
};

const rowFor = (
  baseline: Condition | undefined,
  candidate: Condition | undefined,
  sampleSize: number,
): EvalComparisonRow => {
  const identity = baseline ?? candidate;
  if (identity === undefined) throw new RangeError('A comparison row always has at least one side.');
  const baselineMetrics = baseline === undefined ? undefined : metricsFor(baseline, sampleSize);
  const candidateMetrics = candidate === undefined ? undefined : metricsFor(candidate, sampleSize);

  if (baseline === undefined || candidate === undefined || baselineMetrics === undefined || candidateMetrics === undefined) {
    const model = facetValue((baseline ?? candidate)?.trials.map((trial) => trial.model) ?? []);
    return Object.freeze({
      ...(baselineMetrics === undefined ? {} : { baseline: baselineMetrics }),
      ...(candidateMetrics === undefined ? {} : { candidate: candidateMetrics }),
      caseId: identity.caseId,
      causes: Object.freeze([missingCause(baseline === undefined ? 'missing-baseline' : 'missing-candidate')]),
      comparable: false,
      host: identity.host,
      ...(model.mixed || !model.recorded ? {} : { model: model.value }),
    });
  }

  const baselineFacets = facetsOf(baseline);
  const candidateFacets = facetsOf(candidate);
  const causes: EvalNonComparableCause[] = [];
  for (const facet of alignmentFacets) {
    const left = baselineFacets[facet];
    const right = candidateFacets[facet];
    if (!left.recorded || !right.recorded || left.mixed || right.mixed || left.value !== right.value) {
      causes.push(causeFor(facet, left, right));
    }
  }
  if (baselineMetrics.trials === 0 || candidateMetrics.trials === 0) {
    causes.push(ungradableCause(baselineMetrics, candidateMetrics));
  }

  if (causes.length > 0) {
    const model = baselineFacets.model;
    return Object.freeze({
      baseline: baselineMetrics,
      candidate: candidateMetrics,
      caseId: identity.caseId,
      causes: Object.freeze(causes),
      comparable: false,
      host: identity.host,
      ...(model.mixed || model.value !== candidateFacets.model.value ? {} : { model: model.value }),
    });
  }

  const rowSampleSize = Math.min(sampleSize, baselineMetrics.trials, candidateMetrics.trials);
  const aligned = Object.freeze({
    baseline: metricsFor(baseline, rowSampleSize),
    candidate: metricsFor(candidate, rowSampleSize),
  });
  return Object.freeze({
    baseline: aligned.baseline,
    candidate: aligned.candidate,
    caseId: identity.caseId,
    comparable: true,
    delta: deltaFor(aligned.baseline, aligned.candidate),
    evidence: aligned.baseline.evidence === 'reliability' && aligned.candidate.evidence === 'reliability'
      ? 'reliability'
      : 'smoke',
    host: identity.host,
    model: baselineFacets.model.value,
  });
};

/**
 * Aligns a baseline run with a candidate run condition by condition. A condition is one case on
 * one host; every other facet must align before a delta is produced, and a mismatch is labeled
 * non-comparable instead of being folded into one.
 */
export const compareEvalRuns = (options: EvalComparisonOptions): EvalComparison => {
  const sampleSize = requireSampleSize(options.sampleSize);
  requireUsage(options.baseline);
  requireUsage(options.candidate);
  const baseline = conditionsOf(options.baseline);
  const candidate = conditionsOf(options.candidate);
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])];
  const rows = keys
    .map((key) => rowFor(baseline.get(key), candidate.get(key), sampleSize))
    .sort((left, right) => left.caseId.localeCompare(right.caseId) || left.host.localeCompare(right.host));
  const comparableRows = rows.filter((row): row is EvalComparableRow => row.comparable);
  return Object.freeze({
    baselineRunId: options.baseline.run.id,
    candidateRunId: options.candidate.run.id,
    rows: Object.freeze(rows),
    sampleSize,
    summary: Object.freeze({
      comparable: comparableRows.length,
      nonComparable: rows.length - comparableRows.length,
      reliability: comparableRows.filter((row) => row.evidence === 'reliability').length,
      smoke: comparableRows.filter((row) => row.evidence === 'smoke').length,
    }),
  });
};
