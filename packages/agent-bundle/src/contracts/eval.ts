/**
 * Browser-consumable contract surface for eval runs, trials, comparisons,
 * and provenance labels. Only the dependency-free provenance patterns are
 * runtime exports; everything else is type-only because the eval services
 * behind them touch Node builtins.
 */
export {
  explicitInvocationProvenancePattern,
  provenanceIdentifierPattern,
  semanticGraderIdentityPattern,
} from '../eval/provenance.ts';
export type {
  EvalCaseSummary,
  EvalRunEventsReplay,
  EvalRunResult,
  EvalRunSelection,
  EvalSuiteListing,
  EvalSuiteSummary,
} from '../dev/eval/eval-service.ts';
export type {
  EvalRunEvent,
  EvalRunRecord,
  EvalTrialProvenance,
  EvalTrialRecord,
  EvalTrialUsage,
} from '../eval/run-store.ts';
export type {
  ActivationEvidence,
  EvalAssertionKind,
  EvalAssertionOutcome,
  EvalTrialEvidence,
} from '../eval/types.ts';
export type {
  EvalComparison,
  EvalComparisonDelta,
  EvalComparisonEvidence,
  EvalComparisonRow,
  EvalConditionMetrics,
  EvalNonComparableReason,
} from '../eval/compare.ts';
