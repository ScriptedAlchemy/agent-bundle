import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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

const storeError = (
  code: ConstructorParameters<typeof EvalRunStoreError>[0],
  message: string,
): EvalRunStoreError => new EvalRunStoreError(code, message);

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

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
    segments.some((segment) => !safeSegment.test(segment))
  ) {
    throw storeError('EVAL_RUN_RECORD_INVALID', `${label} must be a path-safe relative path.`);
  }
  return segments.join('/');
};

const writeJsonAtomically = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${path.split('/').pop() ?? 'record'}.stage-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, `${stableJson(value)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const runsRoot = (options: ListEvalRunsOptions): string =>
  resolve(options.projectRoot, options.runsDir ?? defaultEvalRunsDir);

const mintRunId = (createdAt: Date): string =>
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

const freezeArtifact = (value: EvalArtifactBinding): EvalArtifactBinding => {
  if (value.source !== 'explicit' && value.source !== 'run-owned') {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run artifact source must be "explicit" or "run-owned".');
  }
  const targets = Object.entries(value.targetDigests).sort(([left], [right]) => left.localeCompare(right));
  if (targets.length === 0) {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run artifact must record at least one target digest.');
  }
  for (const [target, targetDigest] of targets) {
    requireSafeSegment(target, 'Eval run artifact target name');
    if (typeof targetDigest !== 'string' || targetDigest.length === 0) {
      throw storeError('EVAL_RUN_RECORD_INVALID', `Eval run artifact target ${JSON.stringify(target)} must record a digest.`);
    }
  }
  return Object.freeze({
    manifestPath: value.manifestPath,
    source: value.source,
    targetDigests: Object.freeze(Object.fromEntries(targets)),
  });
};

const parseRunRecord = (value: unknown): EvalRunRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const artifact = value.artifact;
  if (
    value.schemaVersion !== 1 ||
    typeof value.agentBundleVersion !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.harness !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.projectRevision !== 'string' ||
    !isRecord(artifact)
  ) {
    return undefined;
  }
  return Object.freeze({
    agentBundleVersion: value.agentBundleVersion,
    artifact: freezeArtifact(artifact as unknown as EvalArtifactBinding),
    ...(typeof value.completedAt === 'string' ? { completedAt: value.completedAt } : {}),
    createdAt: value.createdAt,
    harness: value.harness,
    id: value.id,
    projectRevision: value.projectRevision,
    schemaVersion: 1,
    ...(isRecord(value.summary) ? { summary: Object.freeze(value.summary as unknown as EvalRunSummary) } : {}),
  });
};

const parseEventRecord = (value: unknown): EvalRunEvent | undefined => {
  if (!isRecord(value)) return undefined;
  const sequence = value.sequence;
  if (
    value.schemaVersion !== 1 ||
    typeof value.kind !== 'string' ||
    typeof value.timestamp !== 'string' ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !('payload' in value)
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind,
    payload: snapshotStrictJsonValue(value.payload),
    schemaVersion: 1,
    sequence,
    timestamp: value.timestamp,
  });
};

const parseTrialRecord = (value: unknown, sourcePath: string): EvalTrialRecord => {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw storeError('EVAL_RUN_CORRUPT', `Eval trial record ${JSON.stringify(sourcePath)} is not schema version 1.`);
  }
  return Object.freeze(value as unknown as EvalTrialRecord);
};

/** One writer owns one run directory; every other process creates its own run. */
export class EvalRunWriter {
  readonly #directory: string;
  #closed = false;
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
    return this.#serialize(async () => {
      const kind = event.kind;
      if (typeof kind !== 'string' || kind.length === 0) {
        throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run event kind must be a non-empty string.');
      }
      this.#sequence += 1;
      const record: EvalRunEvent = Object.freeze({
        kind,
        payload: snapshotStrictJsonValue(event.payload),
        schemaVersion: 1,
        sequence: this.#sequence,
        timestamp: new Date().toISOString(),
      });
      await appendFile(join(this.#directory, eventsFileName), `${stableJson(record)}\n`, 'utf8');
      return record;
    });
  }

  async writeArtifactFile(relativePath: string, contents: string): Promise<string> {
    return this.#serialize(async () => {
      const safePath = requireSafeRelativePath(relativePath, 'Eval run artifact path');
      const target = join(this.#directory, 'artifacts', ...safePath.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
      return `artifacts/${safePath}`;
    });
  }

  async writeTrial(trial: EvalTrialRecordInput): Promise<EvalTrialRecord> {
    return this.#serialize(async () => {
      const caseId = requireSafeSegment(trial.caseId, 'Eval trial caseId');
      const id = requireSafeSegment(trial.id, 'Eval trial id');
      if (trial.harnessFailure !== undefined && trial.pluginFailure !== undefined) {
        throw storeError(
          'EVAL_RUN_RECORD_INVALID',
          'A trial records either a harness failure or a plugin failure, never both.',
        );
      }
      const record: EvalTrialRecord = Object.freeze({ ...trial, caseId, id, schemaVersion: 1 });
      await writeJsonAtomically(join(this.#directory, 'cases', caseId, `${id}.json`), record);
      return record;
    });
  }

  async finish(summary: EvalRunSummary): Promise<EvalRunRecord> {
    return this.#serialize(async () => {
      const record: EvalRunRecord = Object.freeze({
        ...this.#record,
        completedAt: new Date().toISOString(),
        summary: Object.freeze({ ...summary }),
      });
      await writeJsonAtomically(join(this.#directory, runFileName), record);
      this.#record = record;
      return record;
    });
  }

  async close(): Promise<void> {
    await this.#tail;
    this.#closed = true;
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw storeError('EVAL_RUN_CLOSED', `Eval run ${JSON.stringify(this.#record.id)} is closed.`);
    }
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const createEvalRun = async (options: CreateEvalRunOptions): Promise<EvalRunWriter> => {
  const createdAt = (options.now ?? (() => new Date()))();
  const root = runsRoot(options);
  const id = options.runId === undefined
    ? mintRunId(createdAt)
    : requireSafeSegment(options.runId, 'Eval run id');
  const directory = join(root, id);
  const probeProcess = options.probeProcess ?? isProcessRunning;

  await mkdir(directory, { recursive: true });
  const owner: EvalRunOwner = Object.freeze({
    createdAt: createdAt.toISOString(),
    nonce: randomUUID(),
    pid: process.pid,
    schemaVersion: 1,
  });
  try {
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
    agentBundleVersion: options.provenance.agentBundleVersion,
    artifact: freezeArtifact(options.artifact),
    createdAt: createdAt.toISOString(),
    harness: options.provenance.harness,
    id,
    projectRevision: options.provenance.projectRevision,
    schemaVersion: 1,
  });
  await writeJsonAtomically(join(directory, runFileName), record);
  await writeFile(join(directory, eventsFileName), '', { encoding: 'utf8', flag: 'a' });
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  await mkdir(join(directory, 'cases'), { recursive: true });
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
  const events = lines.filter((line) => line.length > 0).map((line) => {
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
  return Object.freeze({
    events: Object.freeze(events),
    ...(trailing.length === 0 ? {} : { incompleteTrailingRecord: trailing }),
  });
};

export const readEvalTrials = async (directory: string): Promise<readonly EvalTrialRecord[]> => {
  const casesRoot = join(resolve(directory), 'cases');
  let caseEntries;
  try {
    caseEntries = await readdir(casesRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    throw error;
  }
  const trials: EvalTrialRecord[] = [];
  for (const caseEntry of caseEntries.filter((entry) => entry.isDirectory())) {
    const trialFiles = await readdir(join(casesRoot, caseEntry.name), { withFileTypes: true });
    for (const trialFile of trialFiles.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
      const sourcePath = join(casesRoot, caseEntry.name, trialFile.name);
      let parsed: unknown;
      try {
        parsed = parseJsonWithoutDuplicateKeys(await readFile(sourcePath, 'utf8'));
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
  const root = runsRoot(options);
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
