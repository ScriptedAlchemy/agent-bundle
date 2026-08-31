import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Immutable per-environment output staging (#74).
 *
 * Rsbuild documents `onAfterEnvironmentCompile` as the per-environment
 * completion hook and awaits it inside that environment compiler's Rspack
 * `done` tap, so an awaited staging copy runs while that compiler cannot
 * start its next write cycle. Each staged checkpoint is an immutable copy of
 * one environment's `writeToDisk` root, keyed by that compilation's Stats
 * hash. Runtime cohorts are then assembled exclusively from a complete
 * hash-compatible checkpoint set, never from the mutable live compiler
 * roots, so a cohort's Stats hashes and its copied bytes always describe the
 * same per-environment moments.
 *
 * Rsbuild 2.2.1 fires the global after-compile hook from the last-completing
 * child's `done` tap without waiting for the other children's asynchronous
 * per-environment hooks, so a cohort request may arrive before its matching
 * checkpoint is staged. Acquisition therefore waits for an exact (environment,
 * hash) match and fails fast once a newer compilation supersedes the awaited
 * hash.
 */

export type RscRuntimeEnvironmentName = 'app' | 'rsc' | 'widget';

export const rscRuntimeEnvironmentNames: readonly RscRuntimeEnvironmentName[] =
  Object.freeze(['app', 'rsc', 'widget'] as const);

export type RscEnvironmentCohortHashes = Readonly<Record<RscRuntimeEnvironmentName, string>>;

/** One immutable staged copy of a single environment's completed output root. */
export interface RscStagedEnvironmentCheckpoint {
  readonly environment: RscRuntimeEnvironmentName;
  /** Relative slash-separated path to sha256 digest for every staged file. */
  readonly files: ReadonlyMap<string, string>;
  /** The Stats hash of the compilation that produced these bytes. */
  readonly hash: string;
  readonly root: string;
}

export interface RscEnvironmentCheckpointCohort {
  readonly checkpoints: Readonly<Record<RscRuntimeEnvironmentName, RscStagedEnvironmentCheckpoint>>;
  /** Unpins the cohort so superseded checkpoints can be garbage-collected. */
  release(): void;
}

/**
 * Validates one freshly staged tree and returns the digests the next staging
 * of the same environment may treat as known carry-over content. Throwing
 * rejects the checkpoint.
 */
export type RscEnvironmentCheckpointValidator = (input: Readonly<{
  readonly files: ReadonlyMap<string, string>;
  readonly priorKnownAssets: ReadonlyMap<string, string>;
  readonly root: string;
}>) => Promise<ReadonlyMap<string, string>>;

export interface RscEnvironmentCheckpointStoreOptions {
  readonly root: string;
  readonly validators?: Partial<Readonly<Record<RscRuntimeEnvironmentName, RscEnvironmentCheckpointValidator>>>;
}

export interface RscEnvironmentCheckpointStore {
  /**
   * Resolves once every environment has a staged checkpoint matching the
   * requested hash, pinning the set against garbage collection. Rejects when
   * a requested hash has been superseded by a newer staged compilation, when
   * staging the requested hash failed, or when the store closes.
   */
  acquireCohort(hashes: RscEnvironmentCohortHashes): Promise<RscEnvironmentCheckpointCohort>;
  close(): Promise<void>;
  /**
   * Records a staging failure that happened before `stage` could run, so
   * cohorts requiring this (environment, hash) fail loudly instead of
   * waiting for a checkpoint that will never land.
   */
  recordStagingFailure(input: Readonly<{
    readonly environment: RscRuntimeEnvironmentName;
    readonly error: Error;
    readonly hash: string;
  }>): void;
  /** Stages an immutable checkpoint of one environment's completed output root. */
  stage(input: Readonly<{
    readonly environment: RscRuntimeEnvironmentName;
    readonly hash: string;
    readonly sourceRoot: string;
  }>): Promise<void>;
}

const maximumSupersededHashHistory = 64;

const digestBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const isSafeSegment = (value: string): boolean =>
  value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');

const assertInside = (root: string, target: string): void => {
  const path = relative(resolve(root), resolve(target));
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('Environment checkpoint path escaped its root.');
  }
};

const fsyncPath = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const copyFileDigested = async (source: string, destination: string): Promise<string> => {
  const bytes = await readFile(source);
  const handle = await open(destination, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return digestBytes(bytes);
};

/**
 * Copies one completed compiler output root into an immutable staging
 * directory, digesting every file. Applies the same containment rules as
 * generation capture: regular files and directories only, no symbolic links,
 * no unsafe path segments.
 */
const stageTree = async (sourceRoot: string, destinationRoot: string): Promise<ReadonlyMap<string, string>> => {
  const sourceStatus = await lstat(sourceRoot);
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error(`Compiler environment ${JSON.stringify(sourceRoot)} must be a regular directory.`);
  }
  await mkdir(destinationRoot, { recursive: false });
  const files = new Map<string, string>();

  const copyDirectory = async (source: string, destination: string, prefix: string): Promise<void> => {
    assertInside(sourceRoot, source);
    assertInside(destinationRoot, destination);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!isSafeSegment(entry.name)) throw new Error('Compiler output contains an unsafe path segment.');
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      assertInside(sourceRoot, sourcePath);
      assertInside(destinationRoot, destinationPath);
      const status = await lstat(sourcePath);
      if (status.isSymbolicLink()) throw new Error('Compiler output cannot contain symbolic links.');
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (status.isDirectory()) {
        await mkdir(destinationPath, { recursive: false });
        await copyDirectory(sourcePath, destinationPath, path);
      } else if (status.isFile()) {
        files.set(path, await copyFileDigested(sourcePath, destinationPath));
      } else {
        throw new Error('Compiler output can contain only regular files and directories.');
      }
    }
    await fsyncPath(destination);
  };

  await copyDirectory(sourceRoot, destinationRoot, '');
  return files;
};

interface CheckpointRecord {
  readonly checkpoint: RscStagedEnvironmentCheckpoint;
  deleted: boolean;
  pins: number;
  superseded: boolean;
}

interface CheckpointWaiter {
  readonly hash: string;
  reject(error: Error): void;
  resolve(record: CheckpointRecord): void;
}

interface EnvironmentState {
  failures: Map<string, Error>;
  knownAssets: ReadonlyMap<string, string>;
  latest: CheckpointRecord | undefined;
  supersededHashes: Set<string>;
  tail: Promise<void>;
  waiters: CheckpointWaiter[];
}

type PendingAcquisition = Readonly<{
  cancel(): void;
  readonly promise: Promise<CheckpointRecord>;
}>;

class EnvironmentCheckpointStore implements RscEnvironmentCheckpointStore {
  readonly #environments = new Map<RscRuntimeEnvironmentName, EnvironmentState>();
  readonly #pendingDeletions = new Set<Promise<void>>();
  readonly #releaseWaiters: Array<() => void> = [];
  readonly #live = new Set<CheckpointRecord>();
  readonly #root: string;
  readonly #validators: Partial<Readonly<Record<RscRuntimeEnvironmentName, RscEnvironmentCheckpointValidator>>>;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #sequence = 0;

  constructor(options: RscEnvironmentCheckpointStoreOptions) {
    this.#root = resolve(options.root);
    this.#validators = options.validators ?? {};
    for (const environment of rscRuntimeEnvironmentNames) {
      this.#environments.set(environment, {
        failures: new Map(),
        knownAssets: new Map(),
        latest: undefined,
        supersededHashes: new Set(),
        tail: Promise.resolve(),
        waiters: [],
      });
    }
  }

  #state(environment: RscRuntimeEnvironmentName): EnvironmentState {
    const state = this.#environments.get(environment);
    if (state === undefined) throw new Error(`Unknown RSC runtime environment ${JSON.stringify(environment)}.`);
    return state;
  }

  #maybeDelete(record: CheckpointRecord): void {
    if (record.deleted || record.pins > 0 || (!record.superseded && !this.#closed)) return;
    record.deleted = true;
    this.#live.delete(record);
    const deletion = rm(record.checkpoint.root, { force: true, recursive: true }).catch(() => undefined);
    this.#pendingDeletions.add(deletion);
    void deletion.finally(() => {
      this.#pendingDeletions.delete(deletion);
      this.#notifyRelease();
    });
  }

  #notifyRelease(): void {
    for (const waiter of this.#releaseWaiters.splice(0)) waiter();
  }

  #unpin(record: CheckpointRecord): void {
    record.pins -= 1;
    this.#maybeDelete(record);
    this.#notifyRelease();
  }

  recordStagingFailure(input: Readonly<{
    readonly environment: RscRuntimeEnvironmentName;
    readonly error: Error;
    readonly hash: string;
  }>): void {
    if (this.#closed || input.hash.length === 0) return;
    const state = this.#state(input.environment);
    if (state.latest?.checkpoint.hash === input.hash) return;
    state.failures.set(input.hash, input.error);
    const remaining = state.waiters.filter((waiter) => waiter.hash !== input.hash);
    const rejected = state.waiters.filter((waiter) => waiter.hash === input.hash);
    state.waiters.length = 0;
    state.waiters.push(...remaining);
    for (const waiter of rejected) waiter.reject(input.error);
  }

  async stage(input: Readonly<{
    readonly environment: RscRuntimeEnvironmentName;
    readonly hash: string;
    readonly sourceRoot: string;
  }>): Promise<void> {
    if (typeof input.hash !== 'string' || input.hash.length === 0) {
      throw new Error(`RSC runtime ${input.environment} compilation has no hash to checkpoint.`);
    }
    const state = this.#state(input.environment);
    const previousTail = state.tail;
    let releaseTail!: () => void;
    state.tail = new Promise<void>((resolveTail) => { releaseTail = resolveTail; });
    await previousTail;
    try {
      if (this.#closed) throw new Error('RSC environment checkpoint store is closed.');
      if (state.latest?.checkpoint.hash === input.hash) return;
      await this.#stageLocked(state, input);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.recordStagingFailure({ environment: input.environment, error: failure, hash: input.hash });
      throw error;
    } finally {
      releaseTail();
    }
  }

  async #stageLocked(
    state: EnvironmentState,
    input: Readonly<{
      readonly environment: RscRuntimeEnvironmentName;
      readonly hash: string;
      readonly sourceRoot: string;
    }>,
  ): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const stagedRoot = join(this.#root, `${input.environment}-${String(++this.#sequence)}`);
    let files: ReadonlyMap<string, string>;
    let knownAssets: ReadonlyMap<string, string>;
    try {
      files = await stageTree(resolve(input.sourceRoot), stagedRoot);
      const validator = this.#validators[input.environment];
      knownAssets = validator === undefined
        ? files
        : await validator({ files, priorKnownAssets: state.knownAssets, root: stagedRoot });
      if (this.#closed) throw new Error('RSC environment checkpoint store is closed.');
    } catch (error) {
      await rm(stagedRoot, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
    const record: CheckpointRecord = {
      checkpoint: Object.freeze({
        environment: input.environment,
        files,
        hash: input.hash,
        root: stagedRoot,
      }),
      deleted: false,
      pins: 0,
      superseded: false,
    };
    const previous = state.latest;
    state.latest = record;
    state.knownAssets = knownAssets;
    state.failures.delete(input.hash);
    state.supersededHashes.delete(input.hash);
    this.#live.add(record);
    if (previous !== undefined) {
      previous.superseded = true;
      state.supersededHashes.add(previous.checkpoint.hash);
      while (state.supersededHashes.size > maximumSupersededHashHistory) {
        const oldest = state.supersededHashes.values().next().value;
        if (oldest === undefined) break;
        state.supersededHashes.delete(oldest);
      }
      this.#maybeDelete(previous);
    }
    const settled = state.waiters.splice(0);
    for (const waiter of settled) {
      if (waiter.hash === input.hash) {
        record.pins += 1;
        waiter.resolve(record);
      } else {
        waiter.reject(new Error(
          `RSC runtime ${input.environment} checkpoint ${JSON.stringify(waiter.hash)} was superseded by a newer compilation.`,
        ));
      }
    }
  }

  #acquire(environment: RscRuntimeEnvironmentName, hash: string): PendingAcquisition {
    const state = this.#state(environment);
    if (this.#closed) {
      return Object.freeze({
        cancel: () => undefined,
        promise: Promise.reject(new Error('RSC environment checkpoint store is closed.')),
      });
    }
    if (typeof hash !== 'string' || hash.length === 0) {
      return Object.freeze({
        cancel: () => undefined,
        promise: Promise.reject(new Error(`RSC runtime ${environment} cohort has no checkpoint hash.`)),
      });
    }
    const failure = state.failures.get(hash);
    if (failure !== undefined) {
      return Object.freeze({
        cancel: () => undefined,
        promise: Promise.reject(new Error(
          `RSC runtime ${environment} checkpoint ${JSON.stringify(hash)} failed to stage: ${failure.message}`,
        )),
      });
    }
    const latest = state.latest;
    if (latest !== undefined && latest.checkpoint.hash === hash) {
      latest.pins += 1;
      let cancelled = false;
      return Object.freeze({
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          this.#unpin(latest);
        },
        promise: Promise.resolve(latest),
      });
    }
    if (state.supersededHashes.has(hash)) {
      return Object.freeze({
        cancel: () => undefined,
        promise: Promise.reject(new Error(
          `RSC runtime ${environment} checkpoint ${JSON.stringify(hash)} was superseded by a newer compilation.`,
        )),
      });
    }
    let waiter!: CheckpointWaiter;
    let resolvedRecord: CheckpointRecord | undefined;
    let cancelled = false;
    const promise = new Promise<CheckpointRecord>((resolvePromise, rejectPromise) => {
      waiter = {
        hash,
        reject: rejectPromise,
        resolve: (record) => {
          resolvedRecord = record;
          if (cancelled) {
            this.#unpin(record);
            rejectPromise(new Error(`RSC runtime ${environment} cohort acquisition was cancelled.`));
            return;
          }
          resolvePromise(record);
        },
      };
    });
    state.waiters.push(waiter);
    return Object.freeze({
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (resolvedRecord !== undefined) {
          this.#unpin(resolvedRecord);
          return;
        }
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
      },
      promise,
    });
  }

  async acquireCohort(hashes: RscEnvironmentCohortHashes): Promise<RscEnvironmentCheckpointCohort> {
    const acquisitions = rscRuntimeEnvironmentNames.map((environment) =>
      Object.freeze({ acquisition: this.#acquire(environment, hashes[environment]), environment }));
    let records: readonly CheckpointRecord[];
    try {
      records = await Promise.all(acquisitions.map(async ({ acquisition }) => acquisition.promise));
    } catch (error) {
      for (const { acquisition } of acquisitions) {
        acquisition.cancel();
        void acquisition.promise.catch(() => undefined);
      }
      throw error;
    }
    let released = false;
    const checkpoints = Object.freeze(Object.fromEntries(
      records.map((record) => [record.checkpoint.environment, record.checkpoint]),
    )) as Readonly<Record<RscRuntimeEnvironmentName, RscStagedEnvironmentCheckpoint>>;
    return Object.freeze({
      checkpoints,
      release: () => {
        if (released) return;
        released = true;
        for (const record of records) this.#unpin(record);
      },
    });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      const closeError = new Error('RSC environment checkpoint store is closed.');
      for (const state of this.#environments.values()) {
        for (const waiter of state.waiters.splice(0)) waiter.reject(closeError);
      }
      for (const record of [...this.#live]) this.#maybeDelete(record);
      this.#closePromise = this.#drain();
    }
    return this.#closePromise;
  }

  async #drain(): Promise<void> {
    while (this.#live.size > 0 || this.#pendingDeletions.size > 0) {
      if (this.#pendingDeletions.size > 0) {
        await Promise.allSettled([...this.#pendingDeletions]);
        continue;
      }
      // Remaining records are pinned by an in-flight cohort; wait for release.
      await new Promise<void>((resolveRelease) => { this.#releaseWaiters.push(resolveRelease); });
    }
  }
}

export const createRscEnvironmentCheckpointStore = (
  options: RscEnvironmentCheckpointStoreOptions,
): RscEnvironmentCheckpointStore => new EnvironmentCheckpointStore(options);
