import { randomUUID } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';

import { isRecord, snapshotStrictJsonValue, type JsonValue } from '../core/strict-json.ts';
import { findCredentialConfiguration } from './credentials.ts';
import { storeError } from './errors.ts';
import { provenanceIdentifierPattern } from './provenance.ts';
import type {
  EvalAssertionOutcome,
  EvalAssertionResult,
  EvalHarnessFailure,
  EvalPluginFailure,
  EvalTrialEvidence,
} from './types.ts';
import type {
  EvalArtifactBinding,
  EvalRunEvent,
  EvalRunEventInput,
  EvalRunOwner,
  EvalRunProvenance,
  EvalRunRecord,
  EvalRunSummary,
  EvalTrialInvocationProvenance,
  EvalTrialProvenance,
  EvalTrialRecord,
  EvalTrialSemanticGraderProvenance,
  EvalTrialUsage,
  ListEvalRunsOptions,
} from './run-store-types.ts';

export const safeSegment = /^[a-z0-9][a-z0-9._-]*$/iu;
export const maximumTrialRecordBytes = 1024 * 1024;
const maximumProvenanceTextLength = 256;

export const requireSafeSegment = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !safeSegment.test(value)) {
    throw storeError('EVAL_RUN_RECORD_INVALID', `${label} must be a path-safe identifier.`);
  }
  return value;
};

export const requireSafeRelativePath = (value: string, label: string): string => {
  const segments = value.split('/');
  if (
    value.length === 0 ||
    value.includes('\\') ||
    segments.some((segment) => segment !== '.agent-bundle' && !safeSegment.test(segment))
  ) {
    throw storeError('EVAL_RUN_RECORD_INVALID', `${label} must be a path-safe relative path.`);
  }
  return value;
};

export const requireRunsDir = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage must be a contained relative path.');
  }
  return value;
};

type RunStoreValidationCode = 'EVAL_RUN_CORRUPT' | 'EVAL_RUN_RECORD_INVALID';
type JsonRecord = Readonly<Record<string, JsonValue>>;

const validationError = (code: RunStoreValidationCode, message: string): never => {
  throw storeError(code, message);
};

const strictJson = (value: unknown, code: RunStoreValidationCode, label: string): JsonValue => {
  try {
    return snapshotStrictJsonValue(value);
  } catch {
    return validationError(code, `${label} must contain only detached strict JSON data.`);
  }
};

const strictRecord = (value: unknown, code: RunStoreValidationCode, label: string): JsonRecord => {
  const snapshot = strictJson(value, code, label);
  if (!isRecord(snapshot)) {
    return validationError(code, `${label} must be a JSON object.`);
  }
  return snapshot as JsonRecord;
};

const requireKeys = (
  value: JsonRecord,
  keys: readonly string[],
  code: RunStoreValidationCode,
  label: string,
): void => {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    validationError(code, `${label} has an invalid schema.`);
  }
};

const requireOptionalKeys = (
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  code: RunStoreValidationCode,
  label: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    validationError(code, `${label} has an invalid schema.`);
  }
};

const property = (value: JsonRecord, key: string, code: RunStoreValidationCode, label: string): JsonValue => {
  if (!Object.hasOwn(value, key)) {
    return validationError(code, `${label} is missing ${JSON.stringify(key)}.`);
  }
  return value[key]!;
};

const requireString = (value: JsonValue, code: RunStoreValidationCode, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return validationError(code, `${label} must be a non-empty string.`);
  }
  return value;
};

const requireBoundedText = (value: JsonValue, code: RunStoreValidationCode, label: string): string => {
  const text = requireString(value, code, label);
  if (text.length > maximumProvenanceTextLength) {
    return validationError(code, `${label} must be at most ${maximumProvenanceTextLength} characters.`);
  }
  return text;
};

/** Durable comparison values are labels, never paths, commands, or credential material. */
const requireProvenanceIdentifier = (value: JsonValue, code: RunStoreValidationCode, label: string): string => {
  const text = requireBoundedText(value, code, label);
  if (!provenanceIdentifierPattern.test(text) || findCredentialConfiguration(text) !== undefined) {
    return validationError(code, 'Eval trial provenance contains an unsafe identifier.');
  }
  return text;
};

const requireTimestamp = (value: JsonValue, code: RunStoreValidationCode, label: string): string => {
  const timestamp = requireString(value, code, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    return validationError(code, `${label} must be a valid timestamp.`);
  }
  return timestamp;
};

const requireInteger = (value: JsonValue, code: RunStoreValidationCode, label: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return validationError(code, `${label} must be a safe integer no smaller than ${minimum}.`);
  }
  return value;
};

const requireBoolean = (value: JsonValue, code: RunStoreValidationCode, label: string): boolean => {
  if (typeof value !== 'boolean') {
    return validationError(code, `${label} must be a boolean.`);
  }
  return value;
};

const requireArray = (value: JsonValue, code: RunStoreValidationCode, label: string): readonly JsonValue[] => {
  if (!Array.isArray(value)) {
    return validationError(code, `${label} must be a JSON array.`);
  }
  return value;
};

const assertionOutcomes = new Set<EvalAssertionOutcome>(['fail', 'inconclusive', 'pass']);
const evidenceLevels = new Set(['inferred', 'observed', 'unavailable']);
const assertionKinds = new Set(['exit-code', 'mcp-call', 'no-mcp-call', 'no-skill-activation', 'outcome', 'skill-activation']);
const harnessFailureCodes = new Set(['EVAL_ARTIFACT_UNAVAILABLE', 'EVAL_FIXTURE_UNAVAILABLE', 'EVAL_GRADER_FAILED', 'EVAL_PROCESS_UNAVAILABLE', 'EVAL_TRACE_UNAVAILABLE']);
const harnessFailureStages = new Set(['artifact', 'fixture', 'grader', 'preflight', 'trace']);
const pluginFailureCodes = new Set(['EVAL_PLUGIN_ASSERTION_FAILED', 'EVAL_PLUGIN_PROCESS_FAILED', 'EVAL_PLUGIN_TIMED_OUT']);

const requireOutcome = (value: JsonValue, code: RunStoreValidationCode, label: string): EvalAssertionOutcome => {
  if (typeof value !== 'string' || !assertionOutcomes.has(value as EvalAssertionOutcome)) {
    return validationError(code, `${label} must be an eval assertion outcome.`);
  }
  return value as EvalAssertionOutcome;
};

const requireEvidenceLevel = (value: JsonValue, code: RunStoreValidationCode, label: string): 'inferred' | 'observed' | 'unavailable' => {
  if (typeof value !== 'string' || !evidenceLevels.has(value)) {
    return validationError(code, `${label} must be an evidence level.`);
  }
  return value as 'inferred' | 'observed' | 'unavailable';
};

/** The store validates the ids it mints, so every minting caller must share this format. */
export const mintRunId = (createdAt: Date): string =>
  `${createdAt.toISOString().replace(/[-:.]/gu, '').replace('T', 't').toLowerCase()}-${randomUUID().slice(0, 8)}`;

const ownerDocumentKeys = ['createdAt', 'nonce', 'pid'];

export const parseOwner = (value: unknown): EvalRunOwner => {
  const owner = strictRecord(value, 'EVAL_RUN_CORRUPT', 'Eval run owner metadata');
  requireKeys(owner, ownerDocumentKeys, 'EVAL_RUN_CORRUPT', 'Eval run owner metadata');
  const pid = owner.pid;
  if (
    typeof owner.createdAt !== 'string' ||
    typeof owner.nonce !== 'string' ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return validationError('EVAL_RUN_CORRUPT', 'Eval run owner metadata has an invalid schema.');
  }
  return Object.freeze({ createdAt: owner.createdAt, nonce: owner.nonce, pid });
};

const parseArtifact = (value: unknown, code: RunStoreValidationCode): EvalArtifactBinding => {
  const record = strictRecord(value, code, 'Eval run artifact');
  requireKeys(record, ['manifestPath', 'source', 'targetDigests'], code, 'Eval run artifact');
  const manifestPath = requireSafeRelativePath(requireString(property(record, 'manifestPath', code, 'Eval run artifact'), code, 'Eval run artifact manifest path'), 'Eval run artifact manifest path');
  const source = property(record, 'source', code, 'Eval run artifact');
  if (source !== 'explicit' && source !== 'run-owned') {
    return validationError(code, 'Eval run artifact source must be "explicit" or "run-owned".');
  }
  const targetDigests = strictRecord(property(record, 'targetDigests', code, 'Eval run artifact'), code, 'Eval run artifact target digests');
  const targets = Object.entries(targetDigests).sort(([left], [right]) => left.localeCompare(right));
  if (targets.length === 0) {
    return validationError(code, 'Eval run artifact must record at least one target digest.');
  }
  const normalizedTargets: [string, string][] = [];
  for (const [target, targetDigest] of targets) {
    requireSafeSegment(target, 'Eval run artifact target name');
    normalizedTargets.push([target, requireString(targetDigest, code, `Eval run artifact target ${JSON.stringify(target)} digest`)]);
  }
  return Object.freeze({
    manifestPath,
    source,
    targetDigests: Object.freeze(Object.fromEntries(normalizedTargets)),
  });
};

const parseProvenance = (value: unknown, code: RunStoreValidationCode): EvalRunProvenance => {
  const record = strictRecord(value, code, 'Eval run provenance');
  requireKeys(record, ['agentBundleVersion', 'harness', 'projectRevision'], code, 'Eval run provenance');
  return Object.freeze({
    agentBundleVersion: requireString(property(record, 'agentBundleVersion', code, 'Eval run provenance'), code, 'Eval run agent bundle version'),
    harness: requireString(property(record, 'harness', code, 'Eval run provenance'), code, 'Eval run harness'),
    projectRevision: requireString(property(record, 'projectRevision', code, 'Eval run provenance'), code, 'Eval run project revision'),
  });
};

const optionRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return validationError('EVAL_RUN_RECORD_INVALID', `${label} must be a plain object.`);
  }
  let descriptors: Record<string | symbol, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      return validationError('EVAL_RUN_RECORD_INVALID', `${label} must be a plain object.`);
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return validationError('EVAL_RUN_RECORD_INVALID', `${label} must not be a proxy or inaccessible object.`);
  }
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key]!;
      return !descriptor.enumerable || !('value' in descriptor);
    })
  ) {
    return validationError('EVAL_RUN_RECORD_INVALID', `${label} must use only enumerable data properties.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value])));
};

export interface ParsedCreateEvalRunOptions {
  readonly artifact: EvalArtifactBinding;
  readonly now?: () => Date;
  readonly probeProcess?: (pid: number) => boolean;
  readonly projectRoot: string;
  readonly provenance: EvalRunProvenance;
  readonly runId?: string;
  readonly runsDir?: string;
}

export const parseCreateOptions = (value: unknown): ParsedCreateEvalRunOptions => {
  const options = optionRecord(value, ['artifact', 'projectRoot', 'provenance'], ['now', 'probeProcess', 'runId', 'runsDir'], 'Eval run options');
  const now = options.now;
  const probeProcess = options.probeProcess;
  const runId = options.runId;
  const runsDir = options.runsDir;
  if (now !== undefined && typeof now !== 'function') {
    return validationError('EVAL_RUN_RECORD_INVALID', 'Eval run now must be a function.');
  }
  if (probeProcess !== undefined && typeof probeProcess !== 'function') {
    return validationError('EVAL_RUN_RECORD_INVALID', 'Eval run probeProcess must be a function.');
  }
  if (runId !== undefined && typeof runId !== 'string') {
    return validationError('EVAL_RUN_RECORD_INVALID', 'Eval run id must be a string.');
  }
  if (runsDir !== undefined && typeof runsDir !== 'string') {
    return validationError('EVAL_RUN_RECORD_INVALID', 'Eval run storage must be a string.');
  }
  return Object.freeze({
    artifact: parseArtifact(options.artifact, 'EVAL_RUN_RECORD_INVALID'),
    ...(now === undefined ? {} : { now: now as () => Date }),
    ...(probeProcess === undefined ? {} : { probeProcess: probeProcess as (pid: number) => boolean }),
    projectRoot: requireString(options.projectRoot as JsonValue, 'EVAL_RUN_RECORD_INVALID', 'Eval run project root'),
    provenance: parseProvenance(options.provenance, 'EVAL_RUN_RECORD_INVALID'),
    ...(runId === undefined ? {} : { runId }),
    ...(runsDir === undefined ? {} : { runsDir }),
  });
};

export const parseListOptions = (value: unknown): ListEvalRunsOptions => {
  const options = optionRecord(value, ['projectRoot'], ['runsDir'], 'Eval run list options');
  if (options.runsDir !== undefined && typeof options.runsDir !== 'string') {
    return validationError('EVAL_RUN_RECORD_INVALID', 'Eval run storage must be a string.');
  }
  return Object.freeze({
    projectRoot: requireString(options.projectRoot as JsonValue, 'EVAL_RUN_RECORD_INVALID', 'Eval run project root'),
    ...(options.runsDir === undefined ? {} : { runsDir: options.runsDir }),
  });
};

const parseSummary = (value: unknown, code: RunStoreValidationCode): EvalRunSummary => {
  const record = strictRecord(value, code, 'Eval run summary');
  requireKeys(record, ['cases', 'fail', 'inconclusive', 'pass', 'trials'], code, 'Eval run summary');
  return Object.freeze({
    cases: requireInteger(property(record, 'cases', code, 'Eval run summary'), code, 'Eval run summary cases'),
    fail: requireInteger(property(record, 'fail', code, 'Eval run summary'), code, 'Eval run summary fail'),
    inconclusive: requireInteger(property(record, 'inconclusive', code, 'Eval run summary'), code, 'Eval run summary inconclusive'),
    pass: requireInteger(property(record, 'pass', code, 'Eval run summary'), code, 'Eval run summary pass'),
    trials: requireInteger(property(record, 'trials', code, 'Eval run summary'), code, 'Eval run summary trials'),
  });
};

export const parseRunSummaryInput = (value: unknown): EvalRunSummary =>
  parseSummary(value, 'EVAL_RUN_RECORD_INVALID');

const parseRunRecordValue = (value: unknown, code: RunStoreValidationCode): EvalRunRecord => {
  const record = strictRecord(value, code, 'Eval run document');
  requireOptionalKeys(record,
    ['agentBundleVersion', 'artifact', 'createdAt', 'harness', 'id', 'projectRevision'],
    ['completedAt', 'summary'],
    code,
    'Eval run document');
  const completedAt = Object.hasOwn(record, 'completedAt')
    ? requireTimestamp(property(record, 'completedAt', code, 'Eval run document'), code, 'Eval run completedAt')
    : undefined;
  const summary = Object.hasOwn(record, 'summary')
    ? parseSummary(property(record, 'summary', code, 'Eval run document'), code)
    : undefined;
  if ((completedAt === undefined) !== (summary === undefined)) {
    return validationError(code, 'Eval run document must record completion time and summary together.');
  }
  return Object.freeze({
    agentBundleVersion: requireString(property(record, 'agentBundleVersion', code, 'Eval run document'), code, 'Eval run agent bundle version'),
    artifact: parseArtifact(property(record, 'artifact', code, 'Eval run document'), code),
    ...(completedAt === undefined ? {} : { completedAt }),
    createdAt: requireTimestamp(property(record, 'createdAt', code, 'Eval run document'), code, 'Eval run createdAt'),
    harness: requireString(property(record, 'harness', code, 'Eval run document'), code, 'Eval run harness'),
    id: requireSafeSegment(requireString(property(record, 'id', code, 'Eval run document'), code, 'Eval run id'), 'Eval run id'),
    projectRevision: requireString(property(record, 'projectRevision', code, 'Eval run document'), code, 'Eval run project revision'),
    ...(summary === undefined ? {} : { summary }),
  });
};

export const parseRunRecord = (value: unknown): EvalRunRecord | undefined => {
  try {
    return parseRunRecordValue(value, 'EVAL_RUN_CORRUPT');
  } catch {
    return undefined;
  }
};

const parseEventRecordValue = (value: unknown, code: RunStoreValidationCode): EvalRunEvent => {
  const record = strictRecord(value, code, 'Eval run event');
  requireKeys(record, ['kind', 'payload', 'sequence', 'timestamp'], code, 'Eval run event');
  return Object.freeze({
    kind: requireString(property(record, 'kind', code, 'Eval run event'), code, 'Eval run event kind'),
    payload: property(record, 'payload', code, 'Eval run event'),
    sequence: requireInteger(property(record, 'sequence', code, 'Eval run event'), code, 'Eval run event sequence', 1),
    timestamp: requireTimestamp(property(record, 'timestamp', code, 'Eval run event'), code, 'Eval run event timestamp'),
  });
};

export const parseEventInput = (value: unknown): EvalRunEventInput & Pick<EvalRunEvent, 'payload'> => {
  const record = strictRecord(value, 'EVAL_RUN_RECORD_INVALID', 'Eval run event input');
  requireKeys(record, ['kind', 'payload'], 'EVAL_RUN_RECORD_INVALID', 'Eval run event input');
  return Object.freeze({
    kind: requireString(property(record, 'kind', 'EVAL_RUN_RECORD_INVALID', 'Eval run event input'), 'EVAL_RUN_RECORD_INVALID', 'Eval run event kind'),
    payload: property(record, 'payload', 'EVAL_RUN_RECORD_INVALID', 'Eval run event input'),
  });
};

export const parseEventRecord = (value: unknown): EvalRunEvent | undefined => {
  try {
    return parseEventRecordValue(value, 'EVAL_RUN_CORRUPT');
  } catch {
    return undefined;
  }
};

const parseAssertion = (value: JsonValue, code: RunStoreValidationCode): EvalAssertionResult => {
  const record = strictRecord(value, code, 'Eval trial assertion');
  requireKeys(record, ['assertionId', 'detail', 'evidence', 'kind', 'outcome'], code, 'Eval trial assertion');
  const kind = requireString(property(record, 'kind', code, 'Eval trial assertion'), code, 'Eval trial assertion kind');
  if (!assertionKinds.has(kind)) {
    return validationError(code, 'Eval trial assertion kind is invalid.');
  }
  return Object.freeze({
    assertionId: requireString(property(record, 'assertionId', code, 'Eval trial assertion'), code, 'Eval trial assertion id'),
    detail: requireString(property(record, 'detail', code, 'Eval trial assertion'), code, 'Eval trial assertion detail'),
    evidence: requireEvidenceLevel(property(record, 'evidence', code, 'Eval trial assertion'), code, 'Eval trial assertion evidence'),
    kind: kind as EvalAssertionResult['kind'],
    outcome: requireOutcome(property(record, 'outcome', code, 'Eval trial assertion'), code, 'Eval trial assertion outcome'),
  });
};

const parseEvidence = (value: JsonValue, code: RunStoreValidationCode): EvalTrialEvidence => {
  const evidence = strictRecord(value, code, 'Eval trial evidence');
  requireKeys(evidence, ['mcp', 'process', 'scripts', 'skillActivation'], code, 'Eval trial evidence');
  const mcp = strictRecord(property(evidence, 'mcp', code, 'Eval trial evidence'), code, 'Eval trial MCP evidence');
  requireKeys(mcp, ['calls', 'level'], code, 'Eval trial MCP evidence');
  const calls = requireArray(property(mcp, 'calls', code, 'Eval trial MCP evidence'), code, 'Eval trial MCP calls').map((call) => {
    const record = strictRecord(call, code, 'Eval trial MCP call');
    requireKeys(record, ['server', 'tool'], code, 'Eval trial MCP call');
    return Object.freeze({
      server: requireString(property(record, 'server', code, 'Eval trial MCP call'), code, 'Eval trial MCP server'),
      tool: requireString(property(record, 'tool', code, 'Eval trial MCP call'), code, 'Eval trial MCP tool'),
    });
  });
  const process = strictRecord(property(evidence, 'process', code, 'Eval trial evidence'), code, 'Eval trial process evidence');
  requireOptionalKeys(process, ['level', 'timedOut'], ['exitCode'], code, 'Eval trial process evidence');
  const scripts = strictRecord(property(evidence, 'scripts', code, 'Eval trial evidence'), code, 'Eval trial script evidence');
  requireKeys(scripts, ['level', 'results'], code, 'Eval trial script evidence');
  const scriptResults = strictRecord(property(scripts, 'results', code, 'Eval trial script evidence'), code, 'Eval trial script results');
  const results = Object.freeze(Object.fromEntries(Object.entries(scriptResults).map(([name, result]) => {
    const record = strictRecord(result, code, `Eval trial script result ${JSON.stringify(name)}`);
    requireKeys(record, ['detail', 'outcome'], code, `Eval trial script result ${JSON.stringify(name)}`);
    return [name, Object.freeze({
      detail: requireString(property(record, 'detail', code, `Eval trial script result ${JSON.stringify(name)}`), code, `Eval trial script result ${JSON.stringify(name)} detail`),
      outcome: requireOutcome(property(record, 'outcome', code, `Eval trial script result ${JSON.stringify(name)}`), code, `Eval trial script result ${JSON.stringify(name)} outcome`),
    })];
  })));
  const skillActivation = strictRecord(property(evidence, 'skillActivation', code, 'Eval trial evidence'), code, 'Eval trial skill evidence');
  requireKeys(skillActivation, ['activated', 'level'], code, 'Eval trial skill evidence');
  const activated = requireArray(property(skillActivation, 'activated', code, 'Eval trial skill evidence'), code, 'Eval trial activated skills')
    .map((skill) => requireString(skill, code, 'Eval trial activated skill'));
  return Object.freeze({
    mcp: Object.freeze({ calls: Object.freeze(calls), level: requireEvidenceLevel(property(mcp, 'level', code, 'Eval trial MCP evidence'), code, 'Eval trial MCP evidence level') }),
    process: Object.freeze({
      ...(Object.hasOwn(process, 'exitCode') ? { exitCode: requireInteger(property(process, 'exitCode', code, 'Eval trial process evidence'), code, 'Eval trial process exit code') } : {}),
      level: requireEvidenceLevel(property(process, 'level', code, 'Eval trial process evidence'), code, 'Eval trial process evidence level'),
      timedOut: requireBoolean(property(process, 'timedOut', code, 'Eval trial process evidence'), code, 'Eval trial process timedOut'),
    }),
    scripts: Object.freeze({ level: requireEvidenceLevel(property(scripts, 'level', code, 'Eval trial script evidence'), code, 'Eval trial script evidence level'), results }),
    skillActivation: Object.freeze({ activated: Object.freeze(activated), level: requireEvidenceLevel(property(skillActivation, 'level', code, 'Eval trial skill evidence'), code, 'Eval trial skill evidence level') }),
  });
};

const parseHarnessFailure = (value: JsonValue, code: RunStoreValidationCode): EvalHarnessFailure => {
  const record = strictRecord(value, code, 'Eval trial harness failure');
  requireKeys(record, ['code', 'message', 'stage'], code, 'Eval trial harness failure');
  const failureCode = requireString(property(record, 'code', code, 'Eval trial harness failure'), code, 'Eval trial harness failure code');
  const stage = requireString(property(record, 'stage', code, 'Eval trial harness failure'), code, 'Eval trial harness failure stage');
  if (!harnessFailureCodes.has(failureCode) || !harnessFailureStages.has(stage)) {
    return validationError(code, 'Eval trial harness failure is invalid.');
  }
  return Object.freeze({
    code: failureCode as EvalHarnessFailure['code'],
    message: requireString(property(record, 'message', code, 'Eval trial harness failure'), code, 'Eval trial harness failure message'),
    stage: stage as EvalHarnessFailure['stage'],
  });
};

const parsePluginFailure = (value: JsonValue, code: RunStoreValidationCode): EvalPluginFailure => {
  const record = strictRecord(value, code, 'Eval trial plugin failure');
  requireKeys(record, ['code', 'message'], code, 'Eval trial plugin failure');
  const failureCode = requireString(property(record, 'code', code, 'Eval trial plugin failure'), code, 'Eval trial plugin failure code');
  if (!pluginFailureCodes.has(failureCode)) {
    return validationError(code, 'Eval trial plugin failure is invalid.');
  }
  return Object.freeze({
    code: failureCode as EvalPluginFailure['code'],
    message: requireString(property(record, 'message', code, 'Eval trial plugin failure'), code, 'Eval trial plugin failure message'),
  });
};

const parseInvocationProvenance = (
  value: JsonValue,
  code: RunStoreValidationCode,
): EvalTrialInvocationProvenance => {
  const record = strictRecord(value, code, 'Eval trial invocation provenance');
  const mode = property(record, 'mode', code, 'Eval trial invocation provenance');
  if (mode === 'automatic') {
    requireOptionalKeys(record, ['mode'], ['skill'], code, 'Eval trial invocation provenance');
    return Object.freeze({
      mode,
      ...(Object.hasOwn(record, 'skill')
        ? { skill: requireProvenanceIdentifier(property(record, 'skill', code, 'Eval trial invocation provenance'), code, 'Eval trial invocation Skill') }
        : {}),
    });
  }
  if (mode === 'none') {
    requireKeys(record, ['mode'], code, 'Eval trial invocation provenance');
    return Object.freeze({ mode });
  }
  if (mode === 'explicit') {
    requireKeys(record, ['mode', 'skill'], code, 'Eval trial invocation provenance');
    return Object.freeze({
      mode,
      skill: requireProvenanceIdentifier(property(record, 'skill', code, 'Eval trial invocation provenance'), code, 'Eval trial invocation Skill'),
    });
  }
  return validationError(code, 'Eval trial invocation provenance mode is invalid.');
};

const parseSemanticGraderProvenance = (
  value: JsonValue,
  code: RunStoreValidationCode,
): Exclude<EvalTrialSemanticGraderProvenance, null> => {
  const record = strictRecord(value, code, 'Eval trial semantic grader provenance');
  if (Object.hasOwn(record, 'state')) {
    requireKeys(record, ['state'], code, 'Eval trial semantic grader provenance');
    if (record.state !== 'unrecorded') {
      return validationError(code, 'Eval trial semantic grader provenance state is invalid.');
    }
    return Object.freeze({ state: 'unrecorded' });
  }
  requireKeys(record, ['contractRevision', 'id', 'model'], code, 'Eval trial semantic grader provenance');
  return Object.freeze({
    contractRevision: requireProvenanceIdentifier(property(record, 'contractRevision', code, 'Eval trial semantic grader provenance'), code, 'Eval semantic grader contract revision'),
    id: requireProvenanceIdentifier(property(record, 'id', code, 'Eval trial semantic grader provenance'), code, 'Eval semantic grader id'),
    model: requireProvenanceIdentifier(property(record, 'model', code, 'Eval trial semantic grader provenance'), code, 'Eval semantic grader model'),
  });
};

const parseTrialProvenance = (value: JsonValue, code: RunStoreValidationCode): EvalTrialProvenance => {
  const record = strictRecord(value, code, 'Eval trial provenance');
  requireOptionalKeys(record, ['invocation', 'semanticGrader'], ['hostCliVersion'], code, 'Eval trial provenance');
  const semanticGrader = property(record, 'semanticGrader', code, 'Eval trial provenance');
  return Object.freeze({
    ...(Object.hasOwn(record, 'hostCliVersion')
      ? { hostCliVersion: requireProvenanceIdentifier(property(record, 'hostCliVersion', code, 'Eval trial provenance'), code, 'Eval host CLI version') }
      : {}),
    invocation: parseInvocationProvenance(property(record, 'invocation', code, 'Eval trial provenance'), code),
    semanticGrader: semanticGrader === null ? null : parseSemanticGraderProvenance(semanticGrader, code),
  });
};

const parseTrialUsage = (value: JsonValue, code: RunStoreValidationCode): EvalTrialUsage => {
  const record = strictRecord(value, code, 'Eval trial usage');
  requireKeys(record, ['inputTokens', 'outputTokens'], code, 'Eval trial usage');
  return Object.freeze({
    inputTokens: requireInteger(property(record, 'inputTokens', code, 'Eval trial usage'), code, 'Eval input tokens'),
    outputTokens: requireInteger(property(record, 'outputTokens', code, 'Eval trial usage'), code, 'Eval output tokens'),
  });
};

const trialInputKeys = ['assertions', 'caseDigest', 'caseId', 'completedAt', 'durationMs', 'evidence', 'fixtureDigest', 'host', 'id', 'model', 'outcome', 'prompt', 'provenance', 'rawArtifacts', 'startedAt', 'targetDigest', 'trialIndex'];

const parseTrialRecordValue = (value: unknown, code: RunStoreValidationCode): EvalTrialRecord => {
  const record = strictRecord(value, code, 'Eval trial record');
  requireOptionalKeys(record,
    trialInputKeys,
    ['harnessFailure', 'pluginFailure', 'usage'],
    code,
    'Eval trial record');
  const harnessFailure = Object.hasOwn(record, 'harnessFailure')
    ? parseHarnessFailure(property(record, 'harnessFailure', code, 'Eval trial record'), code)
    : undefined;
  const pluginFailure = Object.hasOwn(record, 'pluginFailure')
    ? parsePluginFailure(property(record, 'pluginFailure', code, 'Eval trial record'), code)
    : undefined;
  const provenance = parseTrialProvenance(property(record, 'provenance', code, 'Eval trial record'), code);
  const usage = Object.hasOwn(record, 'usage')
    ? parseTrialUsage(property(record, 'usage', code, 'Eval trial record'), code)
    : undefined;
  if (harnessFailure !== undefined && pluginFailure !== undefined) {
    return validationError(code, 'A trial records either a harness failure or a plugin failure, never both.');
  }
  return Object.freeze({
    assertions: Object.freeze(requireArray(property(record, 'assertions', code, 'Eval trial record'), code, 'Eval trial assertions').map((assertion) => parseAssertion(assertion, code))),
    caseDigest: requireString(property(record, 'caseDigest', code, 'Eval trial record'), code, 'Eval trial case digest'),
    caseId: requireSafeSegment(requireString(property(record, 'caseId', code, 'Eval trial record'), code, 'Eval trial case id'), 'Eval trial caseId'),
    completedAt: requireTimestamp(property(record, 'completedAt', code, 'Eval trial record'), code, 'Eval trial completedAt'),
    durationMs: requireInteger(property(record, 'durationMs', code, 'Eval trial record'), code, 'Eval trial duration'),
    evidence: parseEvidence(property(record, 'evidence', code, 'Eval trial record'), code),
    fixtureDigest: requireString(property(record, 'fixtureDigest', code, 'Eval trial record'), code, 'Eval trial fixture digest'),
    ...(harnessFailure === undefined ? {} : { harnessFailure }),
    host: requireString(property(record, 'host', code, 'Eval trial record'), code, 'Eval trial host'),
    id: requireSafeSegment(requireString(property(record, 'id', code, 'Eval trial record'), code, 'Eval trial id'), 'Eval trial id'),
    model: requireString(property(record, 'model', code, 'Eval trial record'), code, 'Eval trial model'),
    outcome: requireOutcome(property(record, 'outcome', code, 'Eval trial record'), code, 'Eval trial outcome'),
    ...(pluginFailure === undefined ? {} : { pluginFailure }),
    prompt: requireString(property(record, 'prompt', code, 'Eval trial record'), code, 'Eval trial prompt'),
    provenance,
    rawArtifacts: Object.freeze(requireArray(property(record, 'rawArtifacts', code, 'Eval trial record'), code, 'Eval trial raw artifacts')
      .map((rawArtifact) => requireSafeRelativePath(requireString(rawArtifact, code, 'Eval trial raw artifact'), 'Eval trial raw artifact'))),
    startedAt: requireTimestamp(property(record, 'startedAt', code, 'Eval trial record'), code, 'Eval trial startedAt'),
    targetDigest: requireString(property(record, 'targetDigest', code, 'Eval trial record'), code, 'Eval trial target digest'),
    trialIndex: requireInteger(property(record, 'trialIndex', code, 'Eval trial record'), code, 'Eval trial index'),
    ...(usage === undefined ? {} : { usage }),
  });
};

export const parseTrialInput = (value: unknown): EvalTrialRecord => parseTrialRecordValue(value, 'EVAL_RUN_RECORD_INVALID');

export const parseTrialRecord = (value: unknown, sourcePath: string): EvalTrialRecord => {
  try {
    return parseTrialRecordValue(value, 'EVAL_RUN_CORRUPT');
  } catch {
    throw storeError('EVAL_RUN_CORRUPT', `Eval trial record ${JSON.stringify(sourcePath)} does not match the trial schema.`);
  }
};
