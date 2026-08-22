import type { JsonValue } from '../core/strict-json.ts';
import type {
  EvalAssertionOutcome,
  EvalAssertionResult,
  EvalHarnessFailure,
  EvalPluginFailure,
  EvalTrialEvidence,
} from './types.ts';

export interface EvalArtifactBinding {
  readonly manifestPath: string;
  readonly source: 'explicit' | 'run-owned';
  readonly targetDigests: Readonly<Record<string, string>>;
}

export interface EvalRunProvenance {
  readonly agentBundleVersion: string;
  readonly harness: string;
  readonly projectRevision: string;
}

export interface EvalRunSummary {
  readonly cases: number;
  readonly fail: number;
  readonly inconclusive: number;
  readonly pass: number;
  readonly trials: number;
}

export interface EvalRunRecord {
  readonly agentBundleVersion: string;
  readonly artifact: EvalArtifactBinding;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly harness: string;
  readonly id: string;
  readonly projectRevision: string;
  readonly summary?: EvalRunSummary;
}

/** A safe, authored invocation identity; it deliberately never carries a command or path. */
export interface EvalTrialInvocationProvenance {
  readonly mode: 'automatic' | 'explicit' | 'none';
  readonly skill?: string;
}

/** The server-owned semantic grader identity used to produce a semantic outcome. */
export interface EvalSemanticGraderProvenance {
  readonly id: string;
  readonly model: string;
}

/** A semantic grader ran but its identity was not safe or complete enough to compare. */
export interface EvalUnrecordedSemanticGraderProvenance {
  readonly state: 'unrecorded';
}

export type EvalTrialSemanticGraderProvenance =
  | EvalSemanticGraderProvenance
  | EvalUnrecordedSemanticGraderProvenance
  | null;

/** Alignment data observed by a trial, limited to safe model, version, and authored identity values. */
export interface EvalTrialProvenance {
  readonly hostCliVersion?: string;
  readonly invocation: EvalTrialInvocationProvenance;
  readonly semanticGrader: EvalTrialSemanticGraderProvenance;
}

/** Normalized token counts reported by a host; absent means that host reported no usable usage. */
export interface EvalTrialUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface EvalTrialRecord {
  readonly assertions: readonly EvalAssertionResult[];
  readonly caseDigest: string;
  readonly caseId: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly evidence: EvalTrialEvidence;
  readonly fixtureDigest: string;
  readonly harnessFailure?: EvalHarnessFailure;
  readonly host: string;
  readonly id: string;
  readonly model: string;
  readonly outcome: EvalAssertionOutcome;
  readonly pluginFailure?: EvalPluginFailure;
  readonly prompt: string;
  readonly provenance: EvalTrialProvenance;
  readonly rawArtifacts: readonly string[];
  readonly startedAt: string;
  readonly targetDigest: string;
  readonly trialIndex: number;
  /** Omitted when the host did not emit normalized token counts. */
  readonly usage?: EvalTrialUsage;
}

export type EvalTrialRecordInput = EvalTrialRecord;

/** The harness only needs durable artifact and normalized trial writes. */
export interface EvalTrialWriter {
  writeArtifactFile(relativePath: string, contents: string): Promise<string>;
  writeTrial(trial: EvalTrialRecordInput): Promise<EvalTrialRecord>;
}

export interface EvalRunEventInput {
  readonly kind: string;
  readonly payload: unknown;
}

export interface EvalRunEvent {
  readonly kind: string;
  readonly payload: JsonValue;
  readonly sequence: number;
  readonly timestamp: string;
}

export interface EvalRunEventsRead {
  readonly events: readonly EvalRunEvent[];
  readonly incompleteTrailingRecord?: string;
}

export interface EvalRunOwner {
  readonly createdAt: string;
  readonly nonce: string;
  readonly pid: number;
}

export interface CreateEvalRunOptions {
  readonly artifact: EvalArtifactBinding;
  readonly now?: () => Date;
  readonly probeProcess?: (pid: number) => boolean;
  readonly projectRoot: string;
  readonly provenance: EvalRunProvenance;
  readonly runId?: string;
  readonly runsDir?: string;
}

export interface ListEvalRunsOptions {
  readonly projectRoot: string;
  readonly runsDir?: string;
}
