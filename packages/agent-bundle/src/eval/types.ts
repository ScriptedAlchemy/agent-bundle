import type { PlaygroundEpochIdentity, PlaygroundTarget } from '../services/playground-service.ts';

/** The evidence strength a harness can honestly claim for one observation channel. */
export type ActivationEvidence = 'inferred' | 'observed' | 'unavailable';

export type EvalAssertionOutcome = 'fail' | 'inconclusive' | 'pass';

export type EvalInvocationMode = 'automatic' | 'explicit' | 'none';

export type EvalAssertionKind =
  | 'exit-code'
  | 'mcp-call'
  | 'no-mcp-call'
  | 'no-skill-activation'
  | 'outcome'
  | 'skill-activation';

export interface EvalExitCodeAssertion {
  readonly expected: number;
  readonly id: string;
  readonly kind: 'exit-code';
  readonly minimumEvidence: ActivationEvidence;
}

export interface EvalMcpCallAssertion {
  readonly atLeast: number;
  readonly id: string;
  readonly kind: 'mcp-call';
  readonly minimumEvidence: ActivationEvidence;
  readonly server: string;
  readonly tool: string;
}

export interface EvalNoMcpCallAssertion {
  readonly id: string;
  readonly kind: 'no-mcp-call';
  readonly minimumEvidence: ActivationEvidence;
  readonly server: string;
  readonly tool?: string;
}

export interface EvalNoSkillActivationAssertion {
  readonly id: string;
  readonly kind: 'no-skill-activation';
  readonly minimumEvidence: ActivationEvidence;
  readonly skill?: string;
}

export interface EvalOutcomeAssertion {
  readonly id: string;
  readonly kind: 'outcome';
  readonly minimumEvidence: ActivationEvidence;
  readonly script: string;
}

export interface EvalSkillActivationAssertion {
  readonly id: string;
  readonly kind: 'skill-activation';
  readonly minimumEvidence: ActivationEvidence;
  readonly skill: string;
}

export type EvalAssertion =
  | EvalExitCodeAssertion
  | EvalMcpCallAssertion
  | EvalNoMcpCallAssertion
  | EvalNoSkillActivationAssertion
  | EvalOutcomeAssertion
  | EvalSkillActivationAssertion;

export interface EvalMcpCallRecord {
  readonly server: string;
  readonly tool: string;
}

export interface EvalActivationEvidence {
  readonly activated: readonly string[];
  readonly level: ActivationEvidence;
}

export interface EvalMcpEvidence {
  readonly calls: readonly EvalMcpCallRecord[];
  readonly level: ActivationEvidence;
}

export interface EvalProcessEvidence {
  readonly exitCode?: number;
  readonly level: ActivationEvidence;
  readonly timedOut: boolean;
}

export interface EvalScriptOutcome {
  readonly detail: string;
  readonly outcome: EvalAssertionOutcome;
}

export interface EvalScriptEvidence {
  readonly level: ActivationEvidence;
  readonly results: Readonly<Record<string, EvalScriptOutcome>>;
}

export interface EvalTrialEvidence {
  readonly mcp: EvalMcpEvidence;
  readonly process: EvalProcessEvidence;
  readonly scripts: EvalScriptEvidence;
  readonly skillActivation: EvalActivationEvidence;
}

export interface EvalAssertionResult {
  readonly assertionId: string;
  readonly detail: string;
  readonly evidence: ActivationEvidence;
  readonly kind: EvalAssertionKind;
  readonly outcome: EvalAssertionOutcome;
}

export type EvalHarnessFailureCode =
  | 'EVAL_ARTIFACT_UNAVAILABLE'
  | 'EVAL_FIXTURE_UNAVAILABLE'
  | 'EVAL_GRADER_FAILED'
  | 'EVAL_PROCESS_UNAVAILABLE'
  | 'EVAL_TRACE_UNAVAILABLE';

export type EvalHarnessFailureStage = 'artifact' | 'fixture' | 'grader' | 'preflight' | 'trace';

/** A defect in Agent Bundle or the host tooling, never evidence about the plugin. */
export interface EvalHarnessFailure {
  readonly code: EvalHarnessFailureCode;
  readonly message: string;
  readonly stage: EvalHarnessFailureStage;
}

export type EvalPluginFailureCode =
  | 'EVAL_PLUGIN_ASSERTION_FAILED'
  | 'EVAL_PLUGIN_PROCESS_FAILED'
  | 'EVAL_PLUGIN_TIMED_OUT';

/** A defect the trial observed in the plugin under test. */
export interface EvalPluginFailure {
  readonly code: EvalPluginFailureCode;
  readonly message: string;
}

export interface EvalHostBinding {
  readonly model: string;
}

export interface EvalInvocation {
  readonly mode: EvalInvocationMode;
  readonly skill?: string;
}

/** A fixture path plus the exact file allowlist a trial copy may contain. */
export interface EvalFixture {
  readonly git: boolean;
  readonly include: readonly string[];
  readonly path: string;
}

export interface EvalFixtureInput {
  readonly git?: boolean;
  readonly include?: readonly string[];
  readonly path: string;
}

export interface EvalCase {
  readonly assertions: readonly EvalAssertion[];
  readonly digest: string;
  readonly fixture: EvalFixture;
  readonly hosts: Readonly<Record<string, EvalHostBinding>>;
  readonly id: string;
  readonly invocation: EvalInvocation;
  readonly prompt: string;
  readonly trials: number;
}

export interface EvalCaseInput {
  readonly assertions: readonly EvalAssertion[];
  readonly fixture: EvalFixtureInput | string;
  readonly hosts: Readonly<Record<string, EvalHostBinding>>;
  readonly id: string;
  readonly invocation: EvalInvocation;
  readonly prompt: string;
  readonly trials?: number;
}

export interface EvalSuite {
  readonly cases: readonly EvalCase[];
  readonly digest: string;
  readonly name: string;
}

export interface EvalSuiteInput {
  readonly cases: readonly (EvalCase | EvalCaseInput)[];
  readonly name: string;
}

/** Draft origin kept for alignment only; the recorded response is deliberately dropped. */
export interface EvalDraftProvenance {
  readonly epoch: PlaygroundEpochIdentity;
  readonly fixtureDigest: string;
  readonly target: PlaygroundTarget;
}

export interface EvalDraftConversion {
  readonly case: EvalCase;
  readonly provenance: EvalDraftProvenance;
}

export interface EvalDraftConversionOptions {
  readonly fixture: EvalFixtureInput | string;
  readonly hosts: Readonly<Record<string, EvalHostBinding>>;
  readonly trials?: number;
}
