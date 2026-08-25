import { z } from 'zod';

import type { EvalComparison } from '../../../agent-bundle/src/contracts/eval.ts';
import {
  explicitInvocationProvenancePattern,
  semanticGraderIdentityPattern,
} from '../../../agent-bundle/src/contracts/eval.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';
import {
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  probabilitySchema,
  safeIntegerSchema,
  safeNumberSchema,
} from '../schema-atoms.ts';

export interface ComparisonClientOptions {
  /** Workbench-owned memory-only session authority shared by all foreground routes. */
  readonly foreground: ForegroundRequestAuthority;
}

export interface ComparisonRequest {
  readonly base: string;
  readonly candidate: string;
}

export class ComparisonClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ComparisonClientError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (): ComparisonClientError =>
  new ComparisonClientError('AB8083', 'Eval comparison route returned an invalid response.');

const provenancePathMarker = /(?:^|[^A-Za-z0-9])(?:file:|[A-Za-z]:|\\\\)/iu;
const provenanceIdentifierSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u)
  .refine((value) => !provenancePathMarker.test(value));
const invocationProvenanceSchema = z.union([
  z.enum(['automatic', 'none']),
  z.string()
    .regex(explicitInvocationProvenancePattern)
    .refine((value) => !provenancePathMarker.test(value)),
]);
const semanticGraderIdentitySchema = z.union([
  z.literal('none'),
  z.string()
    .regex(semanticGraderIdentityPattern)
    .refine((value) => !provenancePathMarker.test(value)),
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

const frozenJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, frozenJson(entry)])));
  }
  return value;
};

const diagnosticError = (value: unknown, status: number): ComparisonClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new ComparisonClientError(value.diagnostic.code, value.diagnostic.message);
  }
  return new ComparisonClientError('AB8083', `Eval comparison request failed with HTTP ${status}.`);
};

const comparisonResult = (value: unknown): EvalComparison => {
  const parsed = comparisonEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  return frozenJson(parsed.data.comparison) as EvalComparison;
};

/** A typed, credential-memory-only browser client for the eval comparison route. */
export class ComparisonClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: ComparisonClientOptions) {
    this.#foreground = options.foreground;
  }

  /** The route aligns the two runs; the page never derives a delta of its own. */
  async compare(request: ComparisonRequest, signal?: AbortSignal): Promise<EvalComparison> {
    const query = new URLSearchParams({ base: request.base, candidate: request.candidate });
    return comparisonResult(await this.#json(
      `/api/evals/comparisons?${query.toString()}`,
      signal === undefined ? {} : { signal },
    ));
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#foreground.protectedRequest(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body;
  }
}
