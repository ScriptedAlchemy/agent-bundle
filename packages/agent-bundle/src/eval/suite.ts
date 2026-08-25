import { digest } from '../core/digest.ts';
import { isContainedRelativePath } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';
import type { DraftEvalCase, PlaygroundSelectedAssertion } from '../dev/playground/playground-store.ts';
import {
  expectExitCode,
  expectMcpCall,
  expectNoMcpCall,
  expectNoSkillActivation,
  expectOutcome,
  expectSkillActivation,
} from './assertions.ts';
import { findCredentialConfiguration } from './credentials.ts';
import { EvalDefinitionError } from './errors.ts';
import type {
  ActivationEvidence,
  EvalAssertion,
  EvalCase,
  EvalCaseInput,
  EvalDraftConversion,
  EvalDraftConversionOptions,
  EvalFixture,
  EvalFixtureInput,
  EvalHostBinding,
  EvalInvocation,
  EvalInvocationMode,
  EvalSuite,
  EvalSuiteInput,
} from './types.ts';

const caseKeys = Object.freeze(['assertions', 'digest', 'fixture', 'hosts', 'id', 'invocation', 'prompt', 'trials']);
const draftKeys = Object.freeze(['assertions', 'epoch', 'fixture', 'invocation', 'outcome', 'target', 'task']);
const fixtureKeys = Object.freeze(['git', 'include', 'path']);
const hostKeys = Object.freeze(['model']);
const invocationKeys = Object.freeze(['mode', 'skill']);
const invocationModes = Object.freeze(['automatic', 'explicit', 'none']);
const maximumTrials = 100;
const parsedSuiteKeys = Object.freeze(['cases', 'digest', 'name']);
const safeIdentifier = /^[a-z0-9][a-z0-9._-]*$/iu;
const suiteKeys = Object.freeze(['cases', 'name']);

const definitionError = (
  code: ConstructorParameters<typeof EvalDefinitionError>[0],
  message: string,
): EvalDefinitionError => new EvalDefinitionError(code, message);

const requireRecord = (
  value: unknown,
  code: ConstructorParameters<typeof EvalDefinitionError>[0],
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw definitionError(code, `${label} must be a plain object.`);
  return value;
};

const requireExactKeys = (
  value: Record<string, unknown>,
  code: ConstructorParameters<typeof EvalDefinitionError>[0],
  label: string,
  allowed: readonly string[],
): void => {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length > 0) {
    throw definitionError(code, `${label} does not accept ${JSON.stringify(unexpected)}.`);
  }
};

const requireIdentifier = (
  value: unknown,
  code: ConstructorParameters<typeof EvalDefinitionError>[0],
  label: string,
): string => {
  if (typeof value !== 'string' || !safeIdentifier.test(value)) {
    throw definitionError(code, `${label} must be a path-safe identifier.`);
  }
  return value;
};

const requireProjectRelativePath = (
  value: unknown,
  code: ConstructorParameters<typeof EvalDefinitionError>[0],
  label: string,
): string => {
  if (typeof value !== 'string' || !isContainedRelativePath(value)) {
    throw definitionError(code, `${label} must be a non-empty relative path that never escapes the suite directory.`);
  }
  return value;
};

const normalizeFixture = (value: EvalFixtureInput | string): EvalFixture => {
  const input: EvalFixtureInput = typeof value === 'string' ? { path: value } : value;
  const record = requireRecord(input, 'EVAL_FIXTURE_INVALID', 'Eval case fixture');
  requireExactKeys(record, 'EVAL_FIXTURE_INVALID', 'Eval case fixture', fixtureKeys);
  const include = input.include ?? ['**'];
  if (!Array.isArray(include) || include.length === 0) {
    throw definitionError('EVAL_FIXTURE_INVALID', 'Eval fixture include must be a non-empty array of patterns.');
  }
  if (input.git !== undefined && typeof input.git !== 'boolean') {
    throw definitionError('EVAL_FIXTURE_INVALID', 'Eval fixture git must be a boolean.');
  }
  return Object.freeze({
    git: input.git ?? false,
    include: Object.freeze([...new Set(include.map((pattern) =>
      requireProjectRelativePath(pattern, 'EVAL_FIXTURE_INVALID', 'Eval fixture include pattern')))].sort()),
    path: requireProjectRelativePath(input.path, 'EVAL_FIXTURE_INVALID', 'Eval fixture path'),
  });
};

const normalizeHosts = (
  value: Readonly<Record<string, EvalHostBinding>>,
): Readonly<Record<string, EvalHostBinding>> => {
  const record = requireRecord(value, 'EVAL_HOST_INVALID', 'Eval case hosts');
  const names = Object.keys(record).sort();
  if (names.length === 0) {
    throw definitionError('EVAL_HOST_INVALID', 'Eval case hosts must pin at least one host.');
  }
  return Object.freeze(Object.fromEntries(names.map((name) => {
    const binding = requireRecord(record[name], 'EVAL_HOST_INVALID', `Eval host ${JSON.stringify(name)}`);
    requireExactKeys(binding, 'EVAL_HOST_INVALID', `Eval host ${JSON.stringify(name)}`, hostKeys);
    const model = binding.model;
    if (typeof model !== 'string' || model.length === 0) {
      throw definitionError('EVAL_HOST_INVALID', `Eval host ${JSON.stringify(name)} must pin a non-empty model.`);
    }
    return [requireIdentifier(name, 'EVAL_HOST_INVALID', 'Eval host name'), Object.freeze({ model })];
  })));
};

const normalizeInvocation = (value: EvalInvocation): EvalInvocation => {
  const record = requireRecord(value, 'EVAL_INVOCATION_INVALID', 'Eval case invocation');
  requireExactKeys(record, 'EVAL_INVOCATION_INVALID', 'Eval case invocation', invocationKeys);
  const mode = record.mode;
  if (typeof mode !== 'string' || !invocationModes.includes(mode)) {
    throw definitionError(
      'EVAL_INVOCATION_INVALID',
      'Eval case invocation mode must be "automatic", "explicit", or "none".',
    );
  }
  const skill = record.skill;
  if (skill !== undefined && (typeof skill !== 'string' || skill.length === 0)) {
    throw definitionError('EVAL_INVOCATION_INVALID', 'Eval case invocation skill must be a non-empty string.');
  }
  if (mode === 'explicit' && skill === undefined) {
    throw definitionError('EVAL_INVOCATION_INVALID', 'An explicit invocation must name the Skill it invokes.');
  }
  if (mode === 'none' && skill !== undefined) {
    throw definitionError('EVAL_INVOCATION_INVALID', 'A negative invocation must not name a Skill to activate.');
  }
  return Object.freeze({ mode: mode as EvalInvocationMode, ...(skill === undefined ? {} : { skill }) });
};

const normalizeAssertion = (value: EvalAssertion): EvalAssertion => {
  const record = requireRecord(value, 'EVAL_ASSERTION_INVALID', 'Eval assertion');
  const minimumEvidence = record.minimumEvidence as ActivationEvidence | undefined;
  if (record.kind === 'exit-code') return expectExitCode(record.expected as number, { minimumEvidence });
  if (record.kind === 'mcp-call') {
    return expectMcpCall({
      atLeast: record.atLeast as number | undefined,
      minimumEvidence,
      server: record.server as string,
      tool: record.tool as string,
    });
  }
  if (record.kind === 'no-mcp-call') {
    return expectNoMcpCall({
      minimumEvidence,
      server: record.server as string,
      tool: record.tool as string | undefined,
    });
  }
  if (record.kind === 'no-skill-activation') {
    return expectNoSkillActivation({ minimumEvidence, skill: record.skill as string | undefined });
  }
  if (record.kind === 'outcome') return expectOutcome({ minimumEvidence, script: record.script as string });
  if (record.kind === 'skill-activation') {
    return expectSkillActivation({ minimumEvidence, skill: record.skill as string });
  }
  throw definitionError('EVAL_ASSERTION_INVALID', `Eval assertion kind ${JSON.stringify(record.kind)} is unsupported.`);
};

const normalizeAssertions = (value: readonly EvalAssertion[]): readonly EvalAssertion[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw definitionError('EVAL_ASSERTION_INVALID', 'Every eval case must declare at least one assertion.');
  }
  const assertions = value.map(normalizeAssertion);
  const identities = new Set(assertions.map((assertion) => assertion.id));
  if (identities.size !== assertions.length) {
    throw definitionError('EVAL_ASSERTION_INVALID', 'Eval case assertions must be unique.');
  }
  return Object.freeze(assertions);
};

const normalizeTrials = (value: number | undefined): number => {
  const trials = value ?? 1;
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > maximumTrials) {
    throw definitionError('EVAL_TRIALS_INVALID', `Eval case trials must be an integer between 1 and ${maximumTrials}.`);
  }
  return trials;
};

const assertNoCredentialConfiguration = (value: unknown, label: string): void => {
  const found = findCredentialConfiguration(value);
  if (found !== undefined) {
    throw definitionError(
      'EVAL_CREDENTIAL_REJECTED',
      `${label} must not configure provider credential material (${found}). Agent Bundle reuses the host CLI's existing signed-in session.`,
    );
  }
};

export const normalizeEvalCase = (value: EvalCase | EvalCaseInput): EvalCase => {
  assertNoCredentialConfiguration(value, 'Eval case');
  const record = requireRecord(value, 'EVAL_CASE_INVALID', 'Eval case');
  requireExactKeys(record, 'EVAL_CASE_INVALID', 'Eval case', caseKeys);
  const prompt = record.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw definitionError('EVAL_PROMPT_INVALID', 'Eval case prompt must be a non-empty string.');
  }
  const normalized = {
    assertions: normalizeAssertions(record.assertions as readonly EvalAssertion[]),
    fixture: normalizeFixture(record.fixture as EvalFixtureInput | string),
    hosts: normalizeHosts(record.hosts as Readonly<Record<string, EvalHostBinding>>),
    id: requireIdentifier(record.id, 'EVAL_CASE_INVALID', 'Eval case id'),
    invocation: normalizeInvocation(record.invocation as EvalInvocation),
    prompt,
    trials: normalizeTrials(record.trials as number | undefined),
  };
  return Object.freeze({ ...normalized, digest: digest(normalized) });
};

export const defineEvalSuite = (value: EvalSuiteInput): EvalSuite => {
  const record = requireRecord(value, 'EVAL_SUITE_INVALID', 'Eval suite');
  requireExactKeys(record, 'EVAL_SUITE_INVALID', 'Eval suite', suiteKeys);
  const name = requireIdentifier(record.name, 'EVAL_SUITE_INVALID', 'Eval suite name');
  const cases = record.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw definitionError('EVAL_SUITE_INVALID', 'Eval suite must declare at least one case.');
  }
  const normalized = Object.freeze(cases.map((entry) => normalizeEvalCase(entry as EvalCase | EvalCaseInput)));
  const identities = new Set(normalized.map((entry) => entry.id));
  if (identities.size !== normalized.length) {
    throw definitionError('EVAL_SUITE_INVALID', 'Eval suite case ids must be unique.');
  }
  return Object.freeze({
    cases: normalized,
    digest: digest({ cases: normalized.map((entry) => entry.digest), name }),
    name,
  });
};

/** Re-derives a suite loaded from disk so a hand-written object cannot impersonate an authored one. */
export const parseEvalSuite = (value: unknown): EvalSuite => {
  const record = requireRecord(value, 'EVAL_SUITE_INVALID', 'Eval suite');
  requireExactKeys(record, 'EVAL_SUITE_INVALID', 'Eval suite', parsedSuiteKeys);
  const suite = defineEvalSuite({ cases: record.cases as readonly EvalCase[], name: record.name as string });
  if (record.digest !== suite.digest) {
    throw definitionError('EVAL_SUITE_INVALID', 'Eval suite digest does not match its authored cases.');
  }
  return suite;
};

const draftError = (message: string): EvalDefinitionError => definitionError('EVAL_DRAFT_INVALID', message);

const draftAssertion = (value: PlaygroundSelectedAssertion): EvalAssertion => {
  if (!isRecord(value)) throw draftError('Draft assertions must be plain objects.');
  const expectation = isRecord(value.expectation) ? value.expectation : {};
  try {
    return normalizeAssertion({ ...expectation, kind: value.kind } as unknown as EvalAssertion);
  } catch (error) {
    throw draftError(
      `Draft assertion ${JSON.stringify(value.id)} is not a supported authored assertion: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const draftInvocation = (draft: DraftEvalCase): EvalInvocation => {
  const intent = isRecord(draft.invocation?.intent) ? draft.invocation.intent : {};
  const mode = typeof intent.mode === 'string' ? intent.mode : draft.invocation?.kind;
  if (typeof mode !== 'string' || !invocationModes.includes(mode)) {
    throw draftError('Draft invocation must record an "automatic", "explicit", or "none" mode.');
  }
  const skill = intent.skill;
  if (skill !== undefined && typeof skill !== 'string') {
    throw draftError('Draft invocation skill must be a string when it is recorded.');
  }
  return normalizeInvocation({
    mode: mode as EvalInvocationMode,
    ...(skill === undefined || mode === 'none' ? {} : { skill }),
  });
};

/**
 * Converts the frozen Playground draft shape. The recorded durable outcome is intentionally
 * discarded so a promoted prompt can never carry a reference answer.
 */
export const evalCaseFromDraft = (
  draft: DraftEvalCase,
  options: EvalDraftConversionOptions,
): EvalDraftConversion => {
  if (!isRecord(draft)) throw draftError('A draft eval case must be a plain object.');
  requireExactKeys(draft, 'EVAL_DRAFT_INVALID', 'Draft eval case', draftKeys);
  const task = draft.task;
  if (!isRecord(task) || typeof task.text !== 'string') {
    throw draftError('A draft eval case must record a task with prompt text.');
  }
  const assertions = Array.isArray(draft.assertions) ? draft.assertions : [];
  return Object.freeze({
    case: normalizeEvalCase({
      assertions: assertions.map(draftAssertion),
      fixture: options.fixture,
      hosts: options.hosts,
      id: requireIdentifier(task.id, 'EVAL_DRAFT_INVALID', 'Draft task id'),
      invocation: draftInvocation(draft),
      prompt: task.text,
      ...(options.trials === undefined ? {} : { trials: options.trials }),
    }),
    provenance: Object.freeze({
      epoch: Object.freeze({ digest: draft.epoch.digest, id: draft.epoch.id }),
      fixtureDigest: draft.fixture.digest,
      target: Object.freeze({
        ...(draft.target.digest === undefined ? {} : { digest: draft.target.digest }),
        name: draft.target.name,
      }),
    }),
  });
};
