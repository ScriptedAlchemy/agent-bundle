import { digest } from '../core/digest.ts';
import { EvalDefinitionError } from './errors.ts';
import { claudeSemanticGraderId } from './graders.ts';
import type {
  ActivationEvidence,
  EvalAssertion,
  EvalAssertionResult,
  EvalExitCodeAssertion,
  EvalMcpCallAssertion,
  EvalNoMcpCallAssertion,
  EvalNoSkillActivationAssertion,
  EvalOutcomeAssertion,
  EvalSkillActivationAssertion,
  EvalTrialEvidence,
} from './types.ts';

export interface EvalEvidenceOptions {
  readonly minimumEvidence?: ActivationEvidence;
}

export interface ExpectMcpCallOptions extends EvalEvidenceOptions {
  readonly atLeast?: number;
  readonly server: string;
  readonly tool: string;
}

export interface ExpectNoMcpCallOptions extends EvalEvidenceOptions {
  readonly server: string;
  readonly tool?: string;
}

export interface ExpectOutcomeOptions extends EvalEvidenceOptions {
  readonly script: string;
}

export interface ExpectSkillActivationOptions extends EvalEvidenceOptions {
  readonly skill: string;
}

export interface ExpectNoSkillActivationOptions extends EvalEvidenceOptions {
  readonly skill?: string;
}

const evidenceRanks: Readonly<Record<ActivationEvidence, number>> = Object.freeze({
  inferred: 1,
  observed: 2,
  unavailable: 0,
});

export const evidenceRank = (evidence: ActivationEvidence): number => evidenceRanks[evidence];

export const satisfiesEvidence = (
  available: ActivationEvidence,
  minimum: ActivationEvidence,
): boolean => evidenceRank(available) >= evidenceRank(minimum);

const assertionError = (message: string): EvalDefinitionError =>
  new EvalDefinitionError('EVAL_ASSERTION_INVALID', message);

/** `unavailable` would accept absent evidence, so it is never a valid declared minimum. */
const requireMinimumEvidence = (value: ActivationEvidence | undefined, fallback: ActivationEvidence): ActivationEvidence => {
  const minimum = value ?? fallback;
  if (minimum !== 'inferred' && minimum !== 'observed') {
    throw assertionError('Assertion minimumEvidence must be "inferred" or "observed".');
  }
  return minimum;
};

const requireName = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw assertionError(`${label} must be a non-empty string.`);
  }
  return value;
};

const requireCount = (value: unknown, label: string, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw assertionError(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
};

const assertionId = (kind: string, expectation: unknown): string =>
  `${kind}:${digest(expectation).slice(0, 16)}`;

export const expectExitCode = (
  expected: number,
  options: EvalEvidenceOptions = {},
): EvalExitCodeAssertion => {
  const expectation = {
    expected: requireCount(expected, 'Expected exit code', 0),
    kind: 'exit-code' as const,
    minimumEvidence: requireMinimumEvidence(options.minimumEvidence, 'observed'),
  };
  return Object.freeze({ ...expectation, id: assertionId(expectation.kind, expectation) });
};

export const expectMcpCall = (options: ExpectMcpCallOptions): EvalMcpCallAssertion => {
  const expectation = {
    atLeast: requireCount(options.atLeast ?? 1, 'Expected MCP call count', 1),
    kind: 'mcp-call' as const,
    minimumEvidence: requireMinimumEvidence(options.minimumEvidence, 'observed'),
    server: requireName(options.server, 'Expected MCP server name'),
    tool: requireName(options.tool, 'Expected MCP tool name'),
  };
  return Object.freeze({ ...expectation, id: assertionId(expectation.kind, expectation) });
};

export const expectNoMcpCall = (options: ExpectNoMcpCallOptions): EvalNoMcpCallAssertion => {
  const expectation = {
    kind: 'no-mcp-call' as const,
    minimumEvidence: requireMinimumEvidence(options.minimumEvidence, 'observed'),
    server: requireName(options.server, 'Forbidden MCP server name'),
    ...(options.tool === undefined ? {} : { tool: requireName(options.tool, 'Forbidden MCP tool name') }),
  };
  return Object.freeze({ ...expectation, id: assertionId(expectation.kind, expectation) });
};

export const expectOutcome = (options: ExpectOutcomeOptions): EvalOutcomeAssertion => {
  if (options.script === claudeSemanticGraderId) {
    throw assertionError(`Authored outcome graders must not use the reserved grader id ${JSON.stringify(claudeSemanticGraderId)}.`);
  }
  const expectation = {
    kind: 'outcome' as const,
    minimumEvidence: requireMinimumEvidence(options.minimumEvidence, 'observed'),
    script: requireName(options.script, 'Expected outcome grader script'),
  };
  return Object.freeze({ ...expectation, id: assertionId(expectation.kind, expectation) });
};

export const expectSkillActivation = (options: ExpectSkillActivationOptions): EvalSkillActivationAssertion => {
  const expectation = {
    kind: 'skill-activation' as const,
    minimumEvidence: requireMinimumEvidence(options.minimumEvidence, 'inferred'),
    skill: requireName(options.skill, 'Expected activated Skill name'),
  };
  return Object.freeze({ ...expectation, id: assertionId(expectation.kind, expectation) });
};

export const expectNoSkillActivation = (
  options: ExpectNoSkillActivationOptions = {},
): EvalNoSkillActivationAssertion => {
  const expectation = {
    kind: 'no-skill-activation' as const,
    minimumEvidence: requireMinimumEvidence(options.minimumEvidence, 'inferred'),
    ...(options.skill === undefined ? {} : { skill: requireName(options.skill, 'Expected non-activated Skill name') }),
  };
  return Object.freeze({ ...expectation, id: assertionId(expectation.kind, expectation) });
};

const result = (
  assertion: EvalAssertion,
  evidence: ActivationEvidence,
  outcome: EvalAssertionResult['outcome'],
  detail: string,
): EvalAssertionResult => Object.freeze({
  assertionId: assertion.id,
  detail,
  evidence,
  kind: assertion.kind,
  outcome,
});

const insufficient = (assertion: EvalAssertion, available: ActivationEvidence): EvalAssertionResult =>
  result(
    assertion,
    available,
    'inconclusive',
    `The harness recorded ${JSON.stringify(available)} evidence but this assertion requires at least ${JSON.stringify(assertion.minimumEvidence)}.`,
  );

const resolveExitCode = (
  assertion: EvalExitCodeAssertion,
  evidence: EvalTrialEvidence,
): EvalAssertionResult => {
  const { exitCode, level, timedOut } = evidence.process;
  if (!satisfiesEvidence(level, assertion.minimumEvidence)) return insufficient(assertion, level);
  if (timedOut) return result(assertion, level, 'fail', 'The trial timed out before the process exited.');
  if (exitCode === undefined) {
    return result(assertion, level, 'inconclusive', 'The harness did not record a process exit code.');
  }
  return exitCode === assertion.expected
    ? result(assertion, level, 'pass', `The process exited with code ${exitCode}.`)
    : result(assertion, level, 'fail', `The process exited with code ${exitCode}, expected ${assertion.expected}.`);
};

const resolveMcpCall = (
  assertion: EvalMcpCallAssertion,
  evidence: EvalTrialEvidence,
): EvalAssertionResult => {
  const { calls, level } = evidence.mcp;
  if (!satisfiesEvidence(level, assertion.minimumEvidence)) return insufficient(assertion, level);
  const matches = calls.filter((call) => call.server === assertion.server && call.tool === assertion.tool).length;
  const description = `${assertion.server}/${assertion.tool} was called ${matches} time(s)`;
  return matches >= assertion.atLeast
    ? result(assertion, level, 'pass', `${description}.`)
    : result(assertion, level, 'fail', `${description}, expected at least ${assertion.atLeast}.`);
};

const resolveNoMcpCall = (
  assertion: EvalNoMcpCallAssertion,
  evidence: EvalTrialEvidence,
): EvalAssertionResult => {
  const { calls, level } = evidence.mcp;
  if (!satisfiesEvidence(level, assertion.minimumEvidence)) return insufficient(assertion, level);
  const matches = calls.filter((call) =>
    call.server === assertion.server && (assertion.tool === undefined || call.tool === assertion.tool)).length;
  const scope = assertion.tool === undefined ? assertion.server : `${assertion.server}/${assertion.tool}`;
  return matches === 0
    ? result(assertion, level, 'pass', `${scope} was never called.`)
    : result(assertion, level, 'fail', `${scope} was called ${matches} time(s), expected none.`);
};

const resolveOutcomeScript = (
  assertion: EvalOutcomeAssertion,
  evidence: EvalTrialEvidence,
): EvalAssertionResult => {
  const { level, results } = evidence.scripts;
  if (!satisfiesEvidence(level, assertion.minimumEvidence)) return insufficient(assertion, level);
  const graded = results[assertion.script];
  if (graded === undefined) {
    return result(
      assertion,
      level,
      'inconclusive',
      `The harness did not record a result for grader ${JSON.stringify(assertion.script)}.`,
    );
  }
  return result(assertion, level, graded.outcome, graded.detail);
};

const resolveSkillActivation = (
  assertion: EvalSkillActivationAssertion,
  evidence: EvalTrialEvidence,
): EvalAssertionResult => {
  const { activated, level } = evidence.skillActivation;
  if (!satisfiesEvidence(level, assertion.minimumEvidence)) return insufficient(assertion, level);
  return activated.includes(assertion.skill)
    ? result(assertion, level, 'pass', `Skill ${JSON.stringify(assertion.skill)} activated with ${level} evidence.`)
    : result(assertion, level, 'fail', `Skill ${JSON.stringify(assertion.skill)} did not activate.`);
};

const resolveNoSkillActivation = (
  assertion: EvalNoSkillActivationAssertion,
  evidence: EvalTrialEvidence,
): EvalAssertionResult => {
  const { activated, level } = evidence.skillActivation;
  if (!satisfiesEvidence(level, assertion.minimumEvidence)) return insufficient(assertion, level);
  if (assertion.skill === undefined) {
    return activated.length === 0
      ? result(assertion, level, 'pass', 'No Skill activated.')
      : result(assertion, level, 'fail', `Skills ${JSON.stringify(activated)} activated.`);
  }
  return activated.includes(assertion.skill)
    ? result(assertion, level, 'fail', `Skill ${JSON.stringify(assertion.skill)} activated.`)
    : result(assertion, level, 'pass', `Skill ${JSON.stringify(assertion.skill)} did not activate.`);
};

export const resolveEvalAssertion = (
  assertion: EvalAssertion,
  evidence: EvalTrialEvidence,
): EvalAssertionResult => {
  if (assertion.kind === 'exit-code') return resolveExitCode(assertion, evidence);
  if (assertion.kind === 'mcp-call') return resolveMcpCall(assertion, evidence);
  if (assertion.kind === 'no-mcp-call') return resolveNoMcpCall(assertion, evidence);
  if (assertion.kind === 'no-skill-activation') return resolveNoSkillActivation(assertion, evidence);
  if (assertion.kind === 'outcome') return resolveOutcomeScript(assertion, evidence);
  return resolveSkillActivation(assertion, evidence);
};

export const resolveEvalAssertions = (
  assertions: readonly EvalAssertion[],
  evidence: EvalTrialEvidence,
): readonly EvalAssertionResult[] =>
  Object.freeze(assertions.map((assertion) => resolveEvalAssertion(assertion, evidence)));
