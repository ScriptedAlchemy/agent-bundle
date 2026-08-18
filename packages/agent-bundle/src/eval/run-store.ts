import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue, type JsonValue } from '../core/strict-json.ts';
import { defaultEvalRunsDir } from './config.ts';
import { EvalRunStoreError } from './errors.ts';
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
  readonly schemaVersion: 1;
  readonly summary?: EvalRunSummary;
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
  readonly rawArtifacts: readonly string[];
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly targetDigest: string;
  readonly trialIndex: number;
}

export type EvalTrialRecordInput = Omit<EvalTrialRecord, 'schemaVersion'>;

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
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly timestamp: string;
}

/** The full JSONL event line exists, but fsync or descriptor close could not confirm its durability. */
export class EvalRunEventDurabilityError extends Error {
  readonly event: EvalRunEvent;
  readonly failures: readonly unknown[];

  constructor(event: EvalRunEvent, failures: readonly unknown[]) {
    super(`Eval run event ${JSON.stringify(event.kind)} was written but could not be durably confirmed.`, { cause: failures[0] });
    this.name = 'EvalRunEventDurabilityError';
    this.event = event;
    this.failures = Object.freeze([...failures]);
  }
}

/** A failed append may have left bytes that could not be durably rolled back to the prior journal boundary. */
export class EvalRunEventWriteUncertainError extends Error {
  readonly event: EvalRunEvent;
  readonly failures: readonly unknown[];

  constructor(event: EvalRunEvent, failures: readonly unknown[]) {
    super(`Eval run event ${JSON.stringify(event.kind)} could not be safely rolled back.`, { cause: failures[0] });
    this.name = 'EvalRunEventWriteUncertainError';
    this.event = event;
    this.failures = Object.freeze([...failures]);
  }
}

export interface EvalRunEventsRead {
  readonly events: readonly EvalRunEvent[];
  readonly incompleteTrailingRecord?: string;
}

export interface EvalRunOwner {
  readonly createdAt: string;
  readonly nonce: string;
  readonly pid: number;
  readonly schemaVersion: 1;
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

const eventsFileName = 'events.jsonl';
const ownerFileName = 'owner.json';
const runFileName = 'run.json';
const safeSegment = /^[a-z0-9][a-z0-9._-]*$/iu;
const safeRelativeSegment = /^(?!\.{1,2}$)[a-z0-9._-]+$/iu;
const maximumTrialRecordBytes = 1024 * 1024;
type EvalRunStoreDurabilityTestHook = (
  phase: 'after-event-write' | 'before-event-open' | 'before-event-rollback' | 'before-event-write',
  event: EvalRunEvent,
  path: string,
  journal: FileHandle | undefined,
) => void | Promise<void>;
const evalRunStoreDurabilityTestHookKey = Symbol.for('agent-bundle.eval-run-store.durability-test-hook');

const storeError = (
  code: ConstructorParameters<typeof EvalRunStoreError>[0],
  message: string,
): EvalRunStoreError => new EvalRunStoreError(code, message);

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

/** Non-API test seam, unavailable unless the process explicitly runs in test mode. */
const runEvalRunStoreDurabilityTestHook = async (
  phase: 'after-event-write' | 'before-event-open' | 'before-event-rollback' | 'before-event-write',
  event: EvalRunEvent,
  path: string,
  journal: FileHandle | undefined,
): Promise<void> => {
  if (process.env.NODE_ENV !== 'test') return;
  const hooks = globalThis as typeof globalThis & Record<symbol, EvalRunStoreDurabilityTestHook | undefined>;
  await hooks[evalRunStoreDurabilityTestHookKey]?.(phase, event, path, journal);
};

const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
};

const requireSafeSegment = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !safeSegment.test(value)) {
    throw storeError('EVAL_RUN_RECORD_INVALID', `${label} must be a path-safe identifier.`);
  }
  return value;
};

const requireSafeRelativePath = (value: string, label: string): string => {
  const segments = value.split('/');
  if (
    value.length === 0 ||
    value.includes('\\') ||
    segments.some((segment) => !safeRelativeSegment.test(segment))
  ) {
    throw storeError('EVAL_RUN_RECORD_INVALID', `${label} must be a path-safe relative path.`);
  }
  return segments.join('/');
};

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path.length === 0 || (!path.startsWith('../') && !path.startsWith('..\\') && path !== '..' && !isAbsolute(path));
};

const requireRunsDir = (value: unknown): string => {
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

const assertNoSymlinkedStorageAncestor = async (projectRoot: string, storageRoot: string): Promise<void> => {
  const relativeStorageRoot = relative(projectRoot, storageRoot);
  if (!isWithin(projectRoot, storageRoot)) {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage must remain within the configured project root.');
  }

  let current = projectRoot;
  for (const segment of relativeStorageRoot.split(/[/\\]/u)) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage must not traverse a symbolic link.');
      }
      if (!entry.isDirectory()) {
        throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage ancestor must be a directory.');
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
  }
};

const ensureStorageRoot = async (projectRoot: string, storageRoot: string): Promise<string> => {
  const physicalProjectRoot = await realpath(projectRoot);
  await assertNoSymlinkedStorageAncestor(projectRoot, storageRoot);
  await mkdir(storageRoot, { recursive: true });
  await assertNoSymlinkedStorageAncestor(projectRoot, storageRoot);
  const physicalStorageRoot = await realpath(storageRoot);
  if (!isWithin(physicalProjectRoot, physicalStorageRoot)) {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage resolves outside the configured project root.');
  }
  return storageRoot;
};

const ensureWritablePath = async (root: string, path: string): Promise<void> => {
  if (!isWithin(root, path)) {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage write escaped its run directory.');
  }
  try {
    const rootEntry = await lstat(root);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage root must remain a real directory.');
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage root no longer exists.');
    }
    throw error;
  }
  const parent = dirname(path);
  const relativeParent = relative(root, parent);
  let current = root;
  for (const segment of relativeParent.length === 0 ? [] : relativeParent.split(/[/\\]/u)) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage must not write through a symbolic link or non-directory ancestor.');
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      await mkdir(current);
    }
  }
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage must not overwrite symbolic links.');
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
};

const writeJsonAtomically = async (root: string, path: string, value: unknown): Promise<void> => {
  await ensureWritablePath(root, path);
  const temporaryPath = join(dirname(path), `.${basename(path) || 'record'}.stage-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, `${stableJson(value)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const runsRoot = (options: ListEvalRunsOptions): string => {
  const projectRoot = resolve(options.projectRoot);
  return resolve(projectRoot, requireRunsDir(options.runsDir ?? defaultEvalRunsDir));
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
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
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
const assertionKinds = new Set(['exit-code', 'mcp-call', 'no-skill-activation', 'outcome', 'skill-activation']);
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

const parseOwner = (value: unknown): EvalRunOwner | undefined => {
  if (!isRecord(value)) return undefined;
  const pid = value.pid;
  if (
    value.schemaVersion !== 1 ||
    typeof value.createdAt !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return undefined;
  }
  return Object.freeze({ createdAt: value.createdAt, nonce: value.nonce, pid, schemaVersion: 1 });
};

const readOwner = async (directory: string): Promise<EvalRunOwner | undefined> => {
  let contents: string;
  try {
    contents = await readFile(join(directory, ownerFileName), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const owner = parseOwner(parseJsonWithoutDuplicateKeys(contents));
  if (owner === undefined) {
    throw storeError('EVAL_RUN_CORRUPT', 'Eval run owner metadata is not a valid ownership record.');
  }
  return owner;
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

interface ParsedCreateEvalRunOptions {
  readonly artifact: EvalArtifactBinding;
  readonly now?: () => Date;
  readonly probeProcess?: (pid: number) => boolean;
  readonly projectRoot: string;
  readonly provenance: EvalRunProvenance;
  readonly runId?: string;
  readonly runsDir?: string;
}

const parseCreateOptions = (value: unknown): ParsedCreateEvalRunOptions => {
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

const parseListOptions = (value: unknown): ListEvalRunsOptions => {
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

const parseRunRecordValue = (value: unknown, code: RunStoreValidationCode): EvalRunRecord => {
  const record = strictRecord(value, code, 'Eval run document');
  requireOptionalKeys(record,
    ['agentBundleVersion', 'artifact', 'createdAt', 'harness', 'id', 'projectRevision', 'schemaVersion'],
    ['completedAt', 'summary'],
    code,
    'Eval run document');
  if (property(record, 'schemaVersion', code, 'Eval run document') !== 1) {
    return validationError(code, 'Eval run document is not schema version 1.');
  }
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
    schemaVersion: 1,
    ...(summary === undefined ? {} : { summary }),
  });
};

const parseRunRecord = (value: unknown): EvalRunRecord | undefined => {
  try {
    return parseRunRecordValue(value, 'EVAL_RUN_CORRUPT');
  } catch {
    return undefined;
  }
};

const parseEventRecordValue = (value: unknown, code: RunStoreValidationCode): EvalRunEvent => {
  const record = strictRecord(value, code, 'Eval run event');
  requireKeys(record, ['kind', 'payload', 'schemaVersion', 'sequence', 'timestamp'], code, 'Eval run event');
  if (property(record, 'schemaVersion', code, 'Eval run event') !== 1) {
    return validationError(code, 'Eval run event is not schema version 1.');
  }
  return Object.freeze({
    kind: requireString(property(record, 'kind', code, 'Eval run event'), code, 'Eval run event kind'),
    payload: property(record, 'payload', code, 'Eval run event'),
    schemaVersion: 1,
    sequence: requireInteger(property(record, 'sequence', code, 'Eval run event'), code, 'Eval run event sequence', 1),
    timestamp: requireTimestamp(property(record, 'timestamp', code, 'Eval run event'), code, 'Eval run event timestamp'),
  });
};

const parseEventRecord = (value: unknown): EvalRunEvent | undefined => {
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

const trialInputKeys = ['assertions', 'caseDigest', 'caseId', 'completedAt', 'durationMs', 'evidence', 'fixtureDigest', 'host', 'id', 'model', 'outcome', 'prompt', 'rawArtifacts', 'startedAt', 'targetDigest', 'trialIndex'];

const parseTrialRecordValue = (value: unknown, code: RunStoreValidationCode, input = false): EvalTrialRecord => {
  const record = strictRecord(value, code, 'Eval trial record');
  requireOptionalKeys(record,
    input ? trialInputKeys : [...trialInputKeys, 'schemaVersion'],
    ['harnessFailure', 'pluginFailure'],
    code,
    'Eval trial record');
  if (!input && property(record, 'schemaVersion', code, 'Eval trial record') !== 1) {
    return validationError(code, 'Eval trial record is not schema version 1.');
  }
  const harnessFailure = Object.hasOwn(record, 'harnessFailure')
    ? parseHarnessFailure(property(record, 'harnessFailure', code, 'Eval trial record'), code)
    : undefined;
  const pluginFailure = Object.hasOwn(record, 'pluginFailure')
    ? parsePluginFailure(property(record, 'pluginFailure', code, 'Eval trial record'), code)
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
    rawArtifacts: Object.freeze(requireArray(property(record, 'rawArtifacts', code, 'Eval trial record'), code, 'Eval trial raw artifacts')
      .map((rawArtifact) => requireSafeRelativePath(requireString(rawArtifact, code, 'Eval trial raw artifact'), 'Eval trial raw artifact'))),
    schemaVersion: 1,
    startedAt: requireTimestamp(property(record, 'startedAt', code, 'Eval trial record'), code, 'Eval trial startedAt'),
    targetDigest: requireString(property(record, 'targetDigest', code, 'Eval trial record'), code, 'Eval trial target digest'),
    trialIndex: requireInteger(property(record, 'trialIndex', code, 'Eval trial record'), code, 'Eval trial index'),
  });
};

const parseTrialInput = (value: unknown): EvalTrialRecord => parseTrialRecordValue(value, 'EVAL_RUN_RECORD_INVALID', true);

const parseTrialRecord = (value: unknown, sourcePath: string): EvalTrialRecord => {
  try {
    return parseTrialRecordValue(value, 'EVAL_RUN_CORRUPT');
  } catch {
    throw storeError('EVAL_RUN_CORRUPT', `Eval trial record ${JSON.stringify(sourcePath)} does not match trial schema version 1.`);
  }
};

/** One writer owns one run directory; every other process creates its own run. */
export class EvalRunWriter implements EvalTrialWriter {
  readonly #directory: string;
  #closed = false;
  #closeFailures: unknown[] = [];
  #closePromise: Promise<void> | undefined;
  #eventJournalFailure: EvalRunEventWriteUncertainError | undefined;
  #record: EvalRunRecord;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(directory: string, record: EvalRunRecord) {
    this.#directory = directory;
    this.#record = record;
  }

  get directory(): string {
    return this.#directory;
  }

  get record(): EvalRunRecord {
    return this.#record;
  }

  async appendEvent(event: EvalRunEventInput): Promise<EvalRunEvent> {
    this.#assertOpen();
    const inputRecord = strictRecord(event, 'EVAL_RUN_RECORD_INVALID', 'Eval run event input');
    requireKeys(inputRecord, ['kind', 'payload'], 'EVAL_RUN_RECORD_INVALID', 'Eval run event input');
    const input = parseEventRecordValue({
      kind: property(inputRecord, 'kind', 'EVAL_RUN_RECORD_INVALID', 'Eval run event input'),
      payload: property(inputRecord, 'payload', 'EVAL_RUN_RECORD_INVALID', 'Eval run event input'),
      schemaVersion: 1,
      sequence: 1,
      timestamp: new Date().toISOString(),
    }, 'EVAL_RUN_RECORD_INVALID');
    if (this.#eventJournalFailure !== undefined) throw this.#eventJournalFailure;
    return this.#serialize(async () => {
      if (this.#eventJournalFailure !== undefined) throw this.#eventJournalFailure;
      const sequence = this.#sequence + 1;
      const record: EvalRunEvent = Object.freeze({
        ...input,
        schemaVersion: 1,
        sequence,
        timestamp: new Date().toISOString(),
      });
      const eventPath = join(this.#directory, eventsFileName);
      await ensureWritablePath(this.#directory, eventPath);
      await runEvalRunStoreDurabilityTestHook('before-event-open', record, eventPath, undefined);
      const journal = await open(eventPath, constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY);
      const failures: unknown[] = [];
      let originalSize: number;
      try {
        originalSize = (await journal.stat()).size;
      } catch (error) {
        failures.push(error);
        try { await journal.close(); }
        catch (closeFailure) { failures.push(closeFailure); }
        if (failures.length === 1) throw error;
        throw new AggregateError(failures, 'Eval run event journal could not be inspected.', { cause: error });
      }
      let written = false;
      let rollbackConfirmed = false;
      try {
        await runEvalRunStoreDurabilityTestHook('before-event-write', record, eventPath, journal);
        await journal.writeFile(`${stableJson(record)}\n`, 'utf8');
        written = true;
        this.#sequence = sequence;
        await runEvalRunStoreDurabilityTestHook('after-event-write', record, eventPath, journal);
        await journal.sync();
      } catch (error) {
        failures.push(error);
        if (!written) {
          try {
            await runEvalRunStoreDurabilityTestHook('before-event-rollback', record, eventPath, journal);
            await journal.truncate(originalSize);
            await journal.sync();
            rollbackConfirmed = true;
          } catch (rollbackFailure) {
            failures.push(rollbackFailure);
          }
        }
      }
      try { await journal.close(); }
      catch (error) { failures.push(error); }
      if (failures.length > 0) {
        if (written) throw new EvalRunEventDurabilityError(record, failures);
        if (!rollbackConfirmed) {
          const uncertain = new EvalRunEventWriteUncertainError(record, failures);
          this.#eventJournalFailure = uncertain;
          this.#closed = true;
          throw uncertain;
        }
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(
          failures,
          `Eval run event ${JSON.stringify(record.kind)} could not be written and was rolled back.`,
          { cause: failures[0] },
        );
      }
      return record;
    });
  }

  async writeArtifactFile(relativePath: string, contents: string): Promise<string> {
    this.#assertOpen();
    const safePath = requireSafeRelativePath(relativePath, 'Eval run artifact path');
    if (typeof contents !== 'string') {
      throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run artifact contents must be a string.');
    }
    return this.#serialize(async () => {
      const target = join(this.#directory, 'artifacts', ...safePath.split('/'));
      await ensureWritablePath(this.#directory, target);
      await writeFile(target, contents, 'utf8');
      return `artifacts/${safePath}`;
    });
  }

  async writeTrial(trial: EvalTrialRecordInput): Promise<EvalTrialRecord> {
    this.#assertOpen();
    const record = parseTrialInput(trial);
    if (Buffer.byteLength(`${stableJson(record)}\n`, 'utf8') > maximumTrialRecordBytes) {
      throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval trial record exceeds the 1 MiB storage limit.');
    }
    return this.#serialize(async () => {
      await writeJsonAtomically(this.#directory, join(this.#directory, 'cases', record.caseId, `${record.id}.json`), record);
      return record;
    });
  }

  async finish(summary: EvalRunSummary): Promise<EvalRunRecord> {
    this.#assertOpen();
    const validatedSummary = parseSummary(summary, 'EVAL_RUN_RECORD_INVALID');
    const finish = this.#serialize(async () => {
      const record: EvalRunRecord = Object.freeze({
        ...this.#record,
        completedAt: new Date().toISOString(),
        summary: validatedSummary,
      });
      await writeJsonAtomically(this.#directory, join(this.#directory, runFileName), record);
      this.#record = record;
      return record;
    });
    this.#closed = true;
    this.#closePromise = this.#drain();
    return finish;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#drain();
    return this.#closePromise;
  }

  async #drain(): Promise<void> {
    await this.#tail;
    if (this.#closeFailures.length > 0) {
      throw new AggregateError(this.#closeFailures, `Eval run ${JSON.stringify(this.#record.id)} closed with admitted write failures.`);
    }
  }

  #assertOpen(): void {
    if (this.#eventJournalFailure !== undefined) throw this.#eventJournalFailure;
    if (this.#closed) {
      throw storeError('EVAL_RUN_CLOSED', `Eval run ${JSON.stringify(this.#record.id)} is closed.`);
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      if (this.#eventJournalFailure !== undefined) throw this.#eventJournalFailure;
      return await operation();
    } catch (error) {
      this.#closeFailures.push(error);
      throw error;
    } finally {
      release();
    }
  }
}

export const createEvalRun = async (options: CreateEvalRunOptions): Promise<EvalRunWriter> => {
  const input = parseCreateOptions(options);
  const createdAt = (input.now ?? (() => new Date()))();
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.valueOf())) {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run now must return a valid Date.');
  }
  const root = runsRoot(input);
  const id = input.runId === undefined
    ? mintRunId(createdAt)
    : requireSafeSegment(input.runId, 'Eval run id');
  const directory = join(root, id);
  const probeProcess = input.probeProcess ?? isProcessRunning;

  await ensureStorageRoot(resolve(input.projectRoot), root);
  try {
    const existing = await lstat(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run directory must be a real directory within run storage.');
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  await mkdir(directory, { recursive: true });
  const owner: EvalRunOwner = Object.freeze({
    createdAt: createdAt.toISOString(),
    nonce: randomUUID(),
    pid: process.pid,
    schemaVersion: 1,
  });
  try {
    await ensureWritablePath(directory, join(directory, ownerFileName));
    await writeFile(join(directory, ownerFileName), `${stableJson(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    const current = await readOwner(directory);
    if (current !== undefined && probeProcess(current.pid)) {
      throw storeError(
        'EVAL_RUN_OWNED',
        `Eval run ${JSON.stringify(id)} is owned by a running process (pid ${current.pid}). Create a new run instead of appending to it.`,
      );
    }
    throw storeError(
      'EVAL_RUN_EXISTS',
      `Eval run ${JSON.stringify(id)} already exists. Runs are immutable once created; create a new run.`,
    );
  }

  const record: EvalRunRecord = Object.freeze({
    agentBundleVersion: input.provenance.agentBundleVersion,
    artifact: input.artifact,
    createdAt: createdAt.toISOString(),
    harness: input.provenance.harness,
    id,
    projectRevision: input.provenance.projectRevision,
    schemaVersion: 1,
  });
  await writeJsonAtomically(directory, join(directory, runFileName), record);
  await ensureWritablePath(directory, join(directory, eventsFileName));
  await writeFile(join(directory, eventsFileName), '', { encoding: 'utf8', flag: 'a' });
  await ensureWritablePath(directory, join(directory, 'artifacts', '.placeholder'));
  await ensureWritablePath(directory, join(directory, 'cases', '.placeholder'));
  return new EvalRunWriter(directory, record);
};

export const readEvalRun = async (directory: string): Promise<EvalRunRecord> => {
  let contents: string;
  try {
    contents = await readFile(join(resolve(directory), runFileName), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw storeError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(directory)} does not exist.`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(contents);
  } catch {
    throw storeError('EVAL_RUN_CORRUPT', 'Eval run document cannot be parsed as JSON.');
  }
  const record = parseRunRecord(parsed);
  if (record === undefined) {
    throw storeError('EVAL_RUN_CORRUPT', 'Eval run document does not match run schema version 1.');
  }
  return record;
};

/**
 * A torn final append is the only tolerated damage: it is skipped and reported,
 * while any complete malformed record makes the run corrupt.
 */
export const readEvalRunEvents = async (directory: string): Promise<EvalRunEventsRead> => {
  let contents: string;
  try {
    contents = await readFile(join(resolve(directory), eventsFileName), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw storeError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(directory)} has no event log.`);
    }
    throw error;
  }
  const lines = contents.split('\n');
  const trailing = lines.pop() ?? '';
  const events = lines.map((line) => {
    if (line.length === 0) {
      throw storeError('EVAL_RUN_CORRUPT', 'Eval run event log contains an empty complete record.');
    }
    let parsed: unknown;
    try {
      parsed = parseJsonWithoutDuplicateKeys(line);
    } catch {
      throw storeError('EVAL_RUN_CORRUPT', 'Eval run event log contains a complete but malformed record.');
    }
    const event = parseEventRecord(parsed);
    if (event === undefined) {
      throw storeError('EVAL_RUN_CORRUPT', 'Eval run event log contains a record that is not event schema version 1.');
    }
    return event;
  });
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw storeError('EVAL_RUN_CORRUPT', 'Eval run event log sequences must be exactly 1 through N.');
    }
  }
  return Object.freeze({
    events: Object.freeze(events),
    ...(trailing.length === 0 ? {} : { incompleteTrailingRecord: trailing }),
  });
};

const trialDirectory = async (path: string): Promise<Stats> => {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw storeError('EVAL_RUN_CORRUPT', 'Eval trial records must remain in real run directories.');
  }
  return entry;
};

const assertTrialDirectory = async (path: string, expected: Stats): Promise<void> => {
  if (!sameFile(expected, await trialDirectory(path))) {
    throw storeError('EVAL_RUN_CORRUPT', 'Eval trial records changed while being read.');
  }
};

interface TrialDirectoryIdentity {
  readonly path: string;
  readonly stats: Stats;
}

const assertTrialDirectories = async (directories: readonly TrialDirectoryIdentity[]): Promise<void> => {
  for (const directory of directories) await assertTrialDirectory(directory.path, directory.stats);
};

const readTrialRecordFile = async (
  sourcePath: string,
  directories: readonly TrialDirectoryIdentity[],
): Promise<unknown> => {
  await assertTrialDirectories(directories);
  const before = await lstat(sourcePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maximumTrialRecordBytes) {
    throw storeError('EVAL_RUN_CORRUPT', 'Eval trial record is not a safe regular file.');
  }
  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptor = await file.stat();
    if (!descriptor.isFile() || descriptor.nlink !== 1 || descriptor.size > maximumTrialRecordBytes || !sameFile(before, descriptor)) {
      throw storeError('EVAL_RUN_CORRUPT', 'Eval trial record changed while opening.');
    }
    const bytes = await file.readFile({ encoding: 'utf8' });
    const [after, final] = await Promise.all([lstat(sourcePath), file.stat()]);
    await assertTrialDirectories(directories);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || !sameFile(before, after) || !sameFile(descriptor, final) ||
      final.size !== descriptor.size || Buffer.byteLength(bytes, 'utf8') !== descriptor.size) {
      throw storeError('EVAL_RUN_CORRUPT', 'Eval trial record changed while reading.');
    }
    return parseJsonWithoutDuplicateKeys(bytes);
  } finally {
    await file.close();
  }
};

interface ReadEvalTrialsOptions {
  /** Internal deterministic seam for verifying that a directory snapshot remains authoritative. */
  readonly afterCasesSnapshot?: () => Promise<void>;
}

export const readEvalTrials = async (
  directory: string,
  options: ReadEvalTrialsOptions = {},
): Promise<readonly EvalTrialRecord[]> => {
  const casesRoot = join(resolve(directory), 'cases');
  let cases: TrialDirectoryIdentity;
  let caseEntries;
  try {
    cases = { path: casesRoot, stats: await trialDirectory(casesRoot) };
    caseEntries = await readdir(casesRoot, { withFileTypes: true });
    await options.afterCasesSnapshot?.();
    await assertTrialDirectory(cases.path, cases.stats);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    throw error;
  }
  const trials: EvalTrialRecord[] = [];
  for (const caseEntry of caseEntries) {
    if (caseEntry.isSymbolicLink()) {
      throw storeError('EVAL_RUN_CORRUPT', 'Eval trial records must not traverse a symbolic link.');
    }
    if (!caseEntry.isDirectory()) continue;
    await assertTrialDirectory(cases.path, cases.stats);
    const caseDirectory = join(casesRoot, caseEntry.name);
    const caseIdentity: TrialDirectoryIdentity = { path: caseDirectory, stats: await trialDirectory(caseDirectory) };
    const trialFiles = await readdir(caseDirectory, { withFileTypes: true });
    await assertTrialDirectories([cases, caseIdentity]);
    for (const trialFile of trialFiles) {
      if (trialFile.isSymbolicLink() && trialFile.name.endsWith('.json')) {
        throw storeError('EVAL_RUN_CORRUPT', 'Eval trial records must not traverse a symbolic link.');
      }
      if (!trialFile.isFile() || !trialFile.name.endsWith('.json')) continue;
      const sourcePath = join(casesRoot, caseEntry.name, trialFile.name);
      let parsed: unknown;
      try {
        parsed = await readTrialRecordFile(sourcePath, [cases, caseIdentity]);
      } catch {
        throw storeError('EVAL_RUN_CORRUPT', `Eval trial record ${JSON.stringify(sourcePath)} cannot be parsed as JSON.`);
      }
      trials.push(parseTrialRecord(parsed, sourcePath));
    }
  }
  return Object.freeze(trials.sort((left, right) =>
    left.caseId.localeCompare(right.caseId) ||
    left.trialIndex - right.trialIndex ||
    left.id.localeCompare(right.id)));
};

export const listEvalRuns = async (options: ListEvalRunsOptions): Promise<readonly string[]> => {
  const root = runsRoot(parseListOptions(options));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && safeSegment.test(candidate.name))) {
    try {
      await lstat(join(root, entry.name, runFileName));
      ids.push(entry.name);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
  return Object.freeze(ids.sort((left, right) => left.localeCompare(right)));
};
