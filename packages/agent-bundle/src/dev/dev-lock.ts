import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { CodedError, isErrno, isTolerableWin32SyncError } from '../core/errors.ts';

export interface DevLockOwner {
  readonly createdAt: string;
  readonly nonce: string;
  readonly pid: number;
  readonly projectRoot: string;
}

export interface DevLockOptions {
  readonly now?: () => Date;
  readonly probeProcess?: (pid: number) => boolean;
  readonly projectRoot: string;
  readonly storage?: DevLockStorage;
}

export interface DevLockStorage {
  readonly link: typeof link;
  readonly lstat: typeof lstat;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly readFile: typeof readFile;
  readonly remove: typeof rm;
}

export type DevLockErrorCode = 'DEV_LOCK_HELD' | 'DEV_LOCK_INVALID';

export class DevLockError extends CodedError<DevLockErrorCode> {
  readonly owner?: DevLockOwner;

  constructor(code: DevLockErrorCode, message: string, owner?: DevLockOwner) {
    super('DevLockError', code, message);
    this.owner = owner;
  }
}

const devLockName = 'dev.lock';
const recoverySuffix = '.recovery';
const defaultStorage: DevLockStorage = Object.freeze({ link, lstat, mkdir, open, readFile, remove: rm });

interface RecoveryRecord {
  readonly owner: DevLockOwner;
}

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
};

const parseOwnerValue = (value: unknown, projectRoot: string): DevLockOwner | undefined => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const parsed = value as Partial<DevLockOwner>;
    const pid = parsed.pid;
    if (
      Object.keys(parsed).length !== 4 ||
      !Object.hasOwn(parsed, 'createdAt') ||
      !Object.hasOwn(parsed, 'nonce') ||
      !Object.hasOwn(parsed, 'pid') ||
      !Object.hasOwn(parsed, 'projectRoot') ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      parsed.nonce.length === 0 ||
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      parsed.projectRoot !== projectRoot
    ) {
      return undefined;
    }
    if (new Date(parsed.createdAt).toISOString() !== parsed.createdAt) return undefined;
    return Object.freeze({
      createdAt: parsed.createdAt,
      nonce: parsed.nonce,
      pid,
      projectRoot: parsed.projectRoot,
    });
  } catch {
    return undefined;
  }
};

const parseOwner = (value: string, projectRoot: string): DevLockOwner | undefined => {
  try {
    const owner = parseOwnerValue(JSON.parse(value), projectRoot);
    return owner !== undefined && value === `${stableJson(owner)}\n` ? owner : undefined;
  } catch {
    return undefined;
  }
};

const parseRecoveryRecord = (value: string, projectRoot: string): RecoveryRecord | undefined => {
  try {
    const parsedValue: unknown = JSON.parse(value);
    if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) return undefined;
    const parsed = parsedValue as Partial<RecoveryRecord>;
    if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'owner')) return undefined;
    const owner = parseOwnerValue(parsed.owner, projectRoot);
    if (owner === undefined) return undefined;
    const recovery = Object.freeze({ owner });
    return value === `${stableJson(recovery)}\n` ? recovery : undefined;
  } catch {
    return undefined;
  }
};

const candidatePathFor = (path: string, nonce: string): string =>
  join(dirname(path), `.${basename(path)}.candidate-${nonce}`);

const syncDirectory = async (storage: DevLockStorage, path: string): Promise<void> => {
  const handle = await storage.open(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (isTolerableWin32SyncError(process.platform, error)) return;
    throw error;
  } finally {
    await handle.close();
  }
};

const writeCompleteExclusive = async (
  storage: DevLockStorage,
  path: string,
  contents: string,
  nonce: string,
): Promise<boolean> => {
  const candidate = candidatePathFor(path, nonce);
  const handle = await storage.open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  let published = false;
  let publicationFailure: unknown;
  try {
    await storage.link(candidate, path);
    published = true;
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) publicationFailure = error;
  }
  let candidateCleanupFailure: unknown;
  try {
    await storage.remove(candidate, { force: true });
  } catch (error) {
    candidateCleanupFailure = error;
  }
  if (publicationFailure !== undefined) {
    if (candidateCleanupFailure !== undefined) {
      throw new AggregateError(
        [publicationFailure, candidateCleanupFailure],
        'Development lock publication and candidate cleanup both failed.',
        { cause: publicationFailure },
      );
    }
    throw publicationFailure;
  }
  if (!published) {
    if (candidateCleanupFailure !== undefined) throw candidateCleanupFailure;
    return false;
  }

  try {
    await syncDirectory(storage, dirname(path));
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await removeIfOwned(storage, path, contents);
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
    try {
      await removeIfOwned(storage, candidate, contents);
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Development lock publication and rollback both failed.',
        { cause: error },
      );
    }
    throw error;
  }
  return true;
};

const removeIfOwned = async (storage: DevLockStorage, path: string, contents: string): Promise<void> => {
  try {
    if (await storage.readFile(path, 'utf8') === contents) {
      await storage.remove(path, { force: true });
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
};

const initialRecoveryRetryDelayMs = 25;
const maximumRecoveryRetryDelayMs = 250;

const sleep = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
};

const recoveryContentsFor = (owner: DevLockOwner): string => `${stableJson({ owner })}\n`;

const acquireRecoveryGate = async (
  storage: DevLockStorage,
  recoveryPath: string,
  owner: DevLockOwner,
  probeProcess: (pid: number) => boolean,
): Promise<string> => {
  const contents = recoveryContentsFor(owner);
  let retryDelayMs = initialRecoveryRetryDelayMs;
  for (;;) {
    if (await writeCompleteExclusive(storage, recoveryPath, contents, owner.nonce)) return contents;

    let currentContents: string;
    try {
      currentContents = await storage.readFile(recoveryPath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
    const recovery = parseRecoveryRecord(currentContents, owner.projectRoot);
    if (recovery === undefined) {
      throw new DevLockError(
        'DEV_LOCK_INVALID',
        'The development lock recovery gate does not contain valid owner metadata.',
      );
    }
    if (probeProcess(recovery.owner.pid)) {
      // A live holder releases the gate on its own schedule; back off instead of busy-waiting.
      await sleep(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, maximumRecoveryRetryDelayMs);
      continue;
    }
    await removeIfOwned(storage, recoveryPath, currentContents);
  }
};

export class DevLock {
  readonly #contents: string;
  readonly #path: string;
  readonly #probeProcess: (pid: number) => boolean;
  readonly #recoveryPath: string;
  readonly #storage: DevLockStorage;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    path: string,
    recoveryPath: string,
    contents: string,
    owner: DevLockOwner,
    probeProcess: (pid: number) => boolean,
    storage: DevLockStorage,
  ) {
    this.#path = path;
    this.#probeProcess = probeProcess;
    this.#recoveryPath = recoveryPath;
    this.#storage = storage;
    this.#contents = contents;
    this.owner = owner;
  }

  readonly owner: DevLockOwner;

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise !== undefined) return this.#closePromise;

    const closePromise = (async () => {
      const recoveryContents = await acquireRecoveryGate(
        this.#storage,
        this.#recoveryPath,
        this.owner,
        this.#probeProcess,
      );
      try {
        await removeIfOwned(this.#storage, this.#path, this.#contents);
        await removeIfOwned(this.#storage, candidatePathFor(this.#path, this.owner.nonce), this.#contents);
      } finally {
        await removeIfOwned(this.#storage, this.#recoveryPath, recoveryContents);
      }
    })();
    this.#closePromise = closePromise;
    void closePromise.then(
      () => {
        this.#closed = true;
        if (this.#closePromise === closePromise) this.#closePromise = undefined;
      },
      () => {
        if (this.#closePromise === closePromise) this.#closePromise = undefined;
      },
    );
    return closePromise;
  }
}

/** Acquires the single writer lock for one project's development epoch store. */
export const acquireDevLock = async (options: DevLockOptions): Promise<DevLock> => {
  const storage = options.storage ?? defaultStorage;
  const projectRoot = resolve(options.projectRoot);
  const path = join(projectRoot, '.agent-bundle', devLockName);
  const owner: DevLockOwner = Object.freeze({
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    nonce: randomUUID(),
    pid: process.pid,
    projectRoot,
  });
  const contents = `${stableJson(owner)}\n`;
  const probeProcess = options.probeProcess ?? isProcessRunning;
  const recoveryPath = `${path}${recoverySuffix}`;
  const directoryPath = dirname(path);
  await storage.mkdir(directoryPath, { recursive: true });
  if (!(await storage.lstat(directoryPath)).isDirectory()) {
    throw new DevLockError(
      'DEV_LOCK_INVALID',
      'The .agent-bundle path must be a directory contained by the project.',
    );
  }

  for (;;) {
    if (await writeCompleteExclusive(storage, path, contents, owner.nonce)) {
      return new DevLock(path, recoveryPath, contents, owner, probeProcess, storage);
    }

    let currentContents: string;
    try {
      currentContents = await storage.readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
    const currentOwner = parseOwner(currentContents, projectRoot);
    if (currentOwner === undefined) {
      throw new DevLockError(
        'DEV_LOCK_INVALID',
        'The existing development lock does not contain valid owner metadata.',
      );
    }
    if (probeProcess(currentOwner.pid)) {
      throw new DevLockError(
        'DEV_LOCK_HELD',
        `Another agent-bundle dev process owns this project (pid ${currentOwner.pid}).`,
        currentOwner,
      );
    }

    const recoveryContents = await acquireRecoveryGate(storage, recoveryPath, owner, probeProcess);
    try {
      let currentDuringRecovery: string;
      try {
        currentDuringRecovery = await storage.readFile(path, 'utf8');
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (currentDuringRecovery !== currentContents) continue;
      const ownerDuringRecovery = parseOwner(currentDuringRecovery, projectRoot);
      if (ownerDuringRecovery === undefined) {
        throw new DevLockError(
          'DEV_LOCK_INVALID',
          'The existing development lock does not contain valid owner metadata.',
        );
      }
      if (probeProcess(ownerDuringRecovery.pid)) continue;
      await removeIfOwned(storage, path, currentContents);
      await removeIfOwned(
        storage,
        candidatePathFor(path, ownerDuringRecovery.nonce),
        currentContents,
      );
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    } finally {
      await removeIfOwned(storage, recoveryPath, recoveryContents);
    }
  }
};
