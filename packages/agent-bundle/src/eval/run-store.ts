import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { serialQueue } from '../core/async.ts';
import { stableJson } from '../core/digest.ts';
import { CodedError, isErrno } from '../core/errors.ts';
import { sameFile, isInsideOrEqual } from '../core/paths.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { defaultEvalRunsDir } from './config.ts';
import { EvalRunStoreError, storeError } from './errors.ts';
import {
  maximumTrialRecordBytes,
  mintRunId,
  parseCreateOptions,
  parseEventInput,
  parseEventRecord,
  parseListOptions,
  parseOwner,
  parseRunRecord,
  parseRunSummaryInput,
  parseTrialInput,
  parseTrialRecord,
  requireRunsDir,
  requireSafeRelativePath,
  safeSegment,
} from './run-store-codec.ts';
import type {
  CreateEvalRunOptions,
  EvalRunEvent,
  EvalRunEventInput,
  EvalRunEventsRead,
  EvalRunOwner,
  EvalRunRecord,
  EvalRunSummary,
  EvalTrialRecord,
  EvalTrialRecordInput,
  EvalTrialWriter,
  ListEvalRunsOptions,
} from './run-store-types.ts';

export type * from './run-store-types.ts';
export { mintRunId };

/** The full JSONL event line exists, but fsync or descriptor close could not confirm its durability. */
export class EvalRunEventDurabilityError extends CodedError<'EVAL_RUN_EVENT_DURABILITY'> {
  readonly event: EvalRunEvent;
  readonly failures: readonly unknown[];

  constructor(event: EvalRunEvent, failures: readonly unknown[]) {
    super(
      'EvalRunEventDurabilityError',
      'EVAL_RUN_EVENT_DURABILITY',
      `Eval run event ${JSON.stringify(event.kind)} was written but could not be durably confirmed.`,
      { cause: failures[0] },
    );
    this.event = event;
    this.failures = Object.freeze([...failures]);
  }
}

/** A failed append may have left bytes that could not be durably rolled back to the prior journal boundary. */
export class EvalRunEventWriteUncertainError extends CodedError<'EVAL_RUN_EVENT_WRITE_UNCERTAIN'> {
  readonly event: EvalRunEvent;
  readonly failures: readonly unknown[];

  constructor(event: EvalRunEvent, failures: readonly unknown[]) {
    super(
      'EvalRunEventWriteUncertainError',
      'EVAL_RUN_EVENT_WRITE_UNCERTAIN',
      `Eval run event ${JSON.stringify(event.kind)} could not be safely rolled back.`,
      { cause: failures[0] },
    );
    this.event = event;
    this.failures = Object.freeze([...failures]);
  }
}

const eventsFileName = 'events.jsonl';
const ownerFileName = 'owner.json';
const runFileName = 'run.json';
type EvalRunStoreDurabilityTestHook = (
  phase: 'after-event-write' | 'before-event-open' | 'before-event-write',
  event: EvalRunEvent,
  path: string,
  journal: FileHandle | undefined,
) => void | Promise<void>;
const evalRunStoreDurabilityTestHookKey = Symbol.for('agent-bundle.eval-run-store.durability-test-hook');

/** A caller-requested run id fails as invalid input, distinct from a corrupt or unwritable record. */
const requireRequestedRunId = (value: string): string => {
  if (!safeSegment.test(value)) {
    throw storeError('EVAL_RUN_ID_INVALID', 'Eval run id must be a path-safe identifier.');
  }
  return value;
};

/** Non-API test seam, unavailable unless the process explicitly runs in test mode. */
const runEvalRunStoreDurabilityTestHook = async (
  phase: 'after-event-write' | 'before-event-open' | 'before-event-write',
  event: EvalRunEvent,
  path: string,
  journal: FileHandle | undefined,
): Promise<void> => {
  if (process.env.NODE_ENV !== 'test') return;
  const hooks = globalThis as typeof globalThis & Record<symbol, EvalRunStoreDurabilityTestHook | undefined>;
  await hooks[evalRunStoreDurabilityTestHookKey]?.(phase, event, path, journal);
};

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
};

const assertNoSymlinkedStorageAncestor = async (projectRoot: string, storageRoot: string): Promise<void> => {
  const relativeStorageRoot = relative(projectRoot, storageRoot);
  if (!isInsideOrEqual(projectRoot, storageRoot)) {
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
  if (!isInsideOrEqual(physicalProjectRoot, physicalStorageRoot)) {
    throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval run storage resolves outside the configured project root.');
  }
  return storageRoot;
};

const ensureWritablePath = async (root: string, path: string): Promise<void> => {
  if (!isInsideOrEqual(root, path)) {
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

const writeJsonAtomically = async (root: string, path: string, value: unknown, serialized?: string): Promise<void> => {
  await ensureWritablePath(root, path);
  const temporaryPath = join(dirname(path), `.${basename(path) || 'record'}.stage-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, serialized ?? `${stableJson(value)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const runsRoot = (options: ListEvalRunsOptions): string => {
  const projectRoot = resolve(options.projectRoot);
  return resolve(projectRoot, requireRunsDir(options.runsDir ?? defaultEvalRunsDir));
};

const readOwner = async (directory: string): Promise<EvalRunOwner | undefined> => {
  let contents: string;
  try {
    contents = await readFile(join(directory, ownerFileName), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    return parseOwner(parseJsonWithoutDuplicateKeys(contents));
  } catch {
    throw storeError('EVAL_RUN_CORRUPT', 'Eval run owner metadata is not a valid ownership record.');
  }
};
export class EvalRunWriter implements EvalTrialWriter {
  readonly #directory: string;
  #closed = false;
  #closeFailures: unknown[] = [];
  #closePromise: Promise<void> | undefined;
  #journal: FileHandle | undefined;
  #journalOffset = 0;
  #record: EvalRunRecord;
  #sequence = 0;
  readonly #queue = serialQueue();
  #uncertainEventWrite = false;

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
    const input = parseEventInput(event);
    return this.#serialize(async () => {
      const sequence = this.#sequence + 1;
      const record: EvalRunEvent = Object.freeze({
        ...input,
        sequence,
        timestamp: new Date().toISOString(),
      });
      const eventPath = join(this.#directory, eventsFileName);
      await ensureWritablePath(this.#directory, eventPath);
      await runEvalRunStoreDurabilityTestHook('before-event-open', record, eventPath, undefined);
      const journal = await this.#ensureJournal(eventPath);
      const failures: unknown[] = [];
      const line = `${stableJson(record)}\n`;
      const boundary = this.#journalOffset;
      let rollbackUncertain = false;
      let writeStarted = false;
      let written = false;
      try {
        writeStarted = true;
        await runEvalRunStoreDurabilityTestHook('before-event-write', record, eventPath, journal);
        await journal.writeFile(line, 'utf8');
        written = true;
        this.#sequence = sequence;
        await runEvalRunStoreDurabilityTestHook('after-event-write', record, eventPath, journal);
        await journal.sync();
        this.#journalOffset = boundary + Buffer.byteLength(line, 'utf8');
      } catch (error) {
        failures.push(error);
        if (writeStarted && !written) {
          try {
            await journal.truncate(boundary);
            await journal.sync();
          } catch (rollbackFailure) {
            rollbackUncertain = true;
            failures.push(rollbackFailure);
          }
        }
      }
      if (failures.length > 0) {
        try { await this.#releaseJournal(); }
        catch (error) {
          failures.push(error);
          if (writeStarted && !written) rollbackUncertain = true;
        }
        if (written) throw new EvalRunEventDurabilityError(record, failures);
        if (rollbackUncertain) {
          this.#uncertainEventWrite = true;
          this.#closed = true;
          throw new EvalRunEventWriteUncertainError(record, failures);
        }
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, `Eval run event ${JSON.stringify(record.kind)} could not be written.`);
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
    const serialized = `${stableJson(record)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > maximumTrialRecordBytes) {
      throw storeError('EVAL_RUN_RECORD_INVALID', 'Eval trial record exceeds the 1 MiB storage limit.');
    }
    return this.#serialize(async () => {
      await writeJsonAtomically(this.#directory, join(this.#directory, 'cases', record.caseId, `${record.id}.json`), record, serialized);
      return record;
    });
  }

  async finish(summary: EvalRunSummary): Promise<EvalRunRecord> {
    this.#assertOpen();
    const validatedSummary = parseRunSummaryInput(summary);
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
    await this.#queue.run(async () => undefined);
    try {
      await this.#releaseJournal();
    } catch (error) {
      this.#closeFailures.push(error);
    }
    if (this.#closeFailures.length > 0) {
      throw new AggregateError(this.#closeFailures, `Eval run ${JSON.stringify(this.#record.id)} closed with admitted write failures.`);
    }
  }

  async #ensureJournal(eventPath: string): Promise<FileHandle> {
    if (this.#journal !== undefined) return this.#journal;
    const journal = await open(eventPath, constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY);
    try {
      this.#journalOffset = (await journal.stat()).size;
    } catch (error) {
      await journal.close().catch(() => undefined);
      throw error;
    }
    this.#journal = journal;
    return journal;
  }

  async #releaseJournal(): Promise<void> {
    const journal = this.#journal;
    this.#journal = undefined;
    if (journal !== undefined) await journal.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw storeError('EVAL_RUN_CLOSED', `Eval run ${JSON.stringify(this.#record.id)} is closed.`);
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    return this.#queue.run(async () => {
      try {
        if (this.#uncertainEventWrite) this.#assertOpen();
        return await operation();
      } catch (error) {
        this.#closeFailures.push(error);
        throw error;
      }
    });
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
    : requireRequestedRunId(input.runId);
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
    throw storeError('EVAL_RUN_CORRUPT', 'Eval run document does not match the run schema.');
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
      throw storeError('EVAL_RUN_CORRUPT', 'Eval run event log contains a record that does not match the event schema.');
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
      } catch (error) {
        // The reader's own store errors carry precise integrity evidence; only
        // relabel the remaining JSON parse and I/O failures.
        if (error instanceof EvalRunStoreError) throw error;
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
