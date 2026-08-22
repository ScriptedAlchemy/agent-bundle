import { z } from 'zod';

import type { EvalComparison } from '../../../agent-bundle/src/eval/compare.ts';
import {
  explicitInvocationProvenancePattern,
  semanticGraderIdentityPattern,
} from '../../../agent-bundle/src/eval/provenance.ts';
import { CodedClientError } from '../client-helpers.ts';
import { ForegroundSessionAuthority, ForegroundTransport } from '../foreground-session.ts';
import { snapshotStrictJsonValue } from '../strict-json.ts';
import {
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  probabilitySchema,
  provenanceIdentifierSchema,
  safeIntegerSchema,
  safeNumberSchema,
} from '../schema-atoms.ts';

export interface ComparisonClientOptions {
  readonly authority?: ForegroundSessionAuthority;
  readonly fetch?: typeof fetch;
}

export interface ComparisonRequest {
  readonly base: string;
  readonly candidate: string;
}

export class ComparisonClientError extends CodedClientError {
  constructor(code: string, message: string) {
    super('ComparisonClientError', code, message);
  }
}

const invalidResponse = (): ComparisonClientError =>
  new ComparisonClientError('AB8083', 'Eval comparison route returned an invalid response.');

const invocationProvenanceSchema = z.union([
  z.enum(['automatic', 'none']),
  z.string().regex(explicitInvocationProvenancePattern),
]);
const semanticGraderIdentitySchema = z.union([
  z.literal('none'),
  z.string().regex(semanticGraderIdentityPattern),
]);
const conditionProvenanceSchema = z.strictObject({
  hostCliVersion: provenanceIdentifierSchema.optional(),
  invocation: invocationProvenanceSchema.optional(),
  semanticGrader: z.union([
    semanticGraderIdentitySchema,
    z.strictObject({ state: z.literal('unrecorded') }),
  ]).optional(),
});
const comparisonUsageSchema = z.strictObject({
  inputTokens: nonnegativeIntegerSchema,
  outputTokens: nonnegativeIntegerSchema,
  recordedTrials: nonnegativeIntegerSchema.refine((value) => value >= 1),
  totalTokens: nonnegativeIntegerSchema,
}).refine((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens);
const reliabilitySchema = z.strictObject({
  passAtK: probabilitySchema,
  passPowerK: probabilitySchema,
  sampleSize: nonnegativeIntegerSchema.refine((value) => value >= 1),
});
const conditionMetricsSchema = z.strictObject({
  durationMs: nonnegativeNumberSchema,
  evidence: z.enum(['reliability', 'smoke']),
  fail: nonnegativeIntegerSchema,
  harnessFailures: nonnegativeIntegerSchema,
  inconclusive: nonnegativeIntegerSchema,
  meanDurationMs: nonnegativeNumberSchema,
  outcome: z.enum(['fail', 'inconclusive', 'pass']),
  passRate: probabilitySchema,
  passes: nonnegativeIntegerSchema,
  provenance: conditionProvenanceSchema,
  reliability: reliabilitySchema.optional(),
  runId: z.string(),
  trials: nonnegativeIntegerSchema,
  usage: comparisonUsageSchema.optional(),
})
  .refine((metrics) => metrics.passes + metrics.fail + metrics.inconclusive === metrics.trials)
  .refine((metrics) => metrics.usage === undefined || metrics.usage.recordedTrials <= metrics.trials);
const deltaSchema = z.strictObject({
  meanDurationMs: safeNumberSchema,
  passRate: safeNumberSchema,
  passes: safeIntegerSchema,
  reliability: reliabilitySchema.optional(),
  totalTokens: safeIntegerSchema.optional(),
  trials: safeIntegerSchema,
});
const nonComparableCauseSchema = z.strictObject({
  baseline: z.string(),
  candidate: z.string(),
  code: z.enum([
    'case-mismatch',
    'fixture-mismatch',
    'harness-mismatch',
    'host-cli-version-mismatch',
    'invocation-mismatch',
    'missing-baseline',
    'missing-candidate',
    'model-mismatch',
    'no-gradable-trials',
    'semantic-grader-identity-mismatch',
  ]),
  message: z.string(),
});
const comparableRowSchema = z.strictObject({
  baseline: conditionMetricsSchema,
  candidate: conditionMetricsSchema,
  caseId: z.string(),
  comparable: z.literal(true),
  delta: deltaSchema,
  evidence: z.enum(['reliability', 'smoke']),
  host: z.string(),
  model: z.string(),
});
const nonComparableRowSchema = z.strictObject({
  baseline: conditionMetricsSchema.optional(),
  candidate: conditionMetricsSchema.optional(),
  caseId: z.string(),
  causes: z.array(nonComparableCauseSchema),
  comparable: z.literal(false),
  host: z.string(),
  model: z.string().optional(),
});
const comparisonSchema = z.strictObject({
  baselineRunId: z.string(),
  candidateRunId: z.string(),
  rows: z.array(z.union([comparableRowSchema, nonComparableRowSchema])),
  sampleSize: nonnegativeIntegerSchema.refine((value) => value >= 1),
  summary: z.strictObject({
    comparable: nonnegativeIntegerSchema,
    nonComparable: nonnegativeIntegerSchema,
    reliability: nonnegativeIntegerSchema,
    smoke: nonnegativeIntegerSchema,
  }),
});
const comparisonEnvelopeSchema = z.strictObject({ comparison: comparisonSchema });

const comparisonResult = (value: unknown): EvalComparison => {
  const parsed = comparisonEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  // The snapshot is a deep-frozen clone of the zod-validated comparison, so the
  // widening below restates what safeParse already proved about its shape.
  const frozen: unknown = snapshotStrictJsonValue(parsed.data.comparison);
  return frozen as EvalComparison;
};

/** A typed, credential-memory-only browser client for the eval comparison route. */
export class ComparisonClient {
  readonly #transport: ForegroundTransport;

  constructor(options: ComparisonClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new ComparisonClientError(code, message),
      fallbackCode: 'AB8083',
      ...(options.authority === undefined ? {} : { authority: options.authority }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Eval comparison',
    });
  }

  /** The route aligns the two runs; the page never derives a delta of its own. */
  async compare(request: ComparisonRequest, signal?: AbortSignal): Promise<EvalComparison> {
    const query = new URLSearchParams({ base: request.base, candidate: request.candidate });
    return comparisonResult(await this.#transport.json(
      `/api/evals/comparisons?${query.toString()}`,
      signal === undefined ? {} : { signal },
    ));
  }

}
