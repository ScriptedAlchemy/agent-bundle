import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';

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
}

export type DevLockErrorCode = 'DEV_LOCK_HELD' | 'DEV_LOCK_INVALID';

export class DevLockError extends Error {
  readonly code: DevLockErrorCode;
  readonly owner?: DevLockOwner;

  constructor(code: DevLockErrorCode, message: string, owner?: DevLockOwner) {
    super(message);
    this.name = 'DevLockError';
    this.code = code;
    this.owner = owner;
  }
}

const devLockName = 'dev.lock';
const recoverySuffix = '.recovery';

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

const parseOwnerValue = (value: unknown): DevLockOwner | undefined => {
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
      typeof parsed.projectRoot !== 'string'
    ) {
      return undefined;
    }
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

const parseOwner = (value: string): DevLockOwner | undefined => {
  try {
    return parseOwnerValue(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const parseRecoveryRecord = (value: string): RecoveryRecord | undefined => {
  try {
    const parsedValue: unknown = JSON.parse(value);
    if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) return undefined;
    const parsed = parsedValue as Partial<RecoveryRecord>;
    if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'owner')) return undefined;
    const owner = parseOwnerValue(parsed.owner);
    return owner === undefined ? undefined : Object.freeze({ owner });
  } catch {
    return undefined;
  }
};

const writeCompleteExclusive = async (path: string, contents: string, nonce: string): Promise<boolean> => {
  const candidate = join(dirname(path), `.${basename(path)}.candidate-${nonce}`);
  try {
    await writeFile(candidate, contents, { encoding: 'utf8', flag: 'wx' });
    try {
      await link(candidate, path);
      return true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw error;
    }
  } finally {
    await rm(candidate, { force: true });
  }
};

const removeIfOwned = async (path: string, contents: string): Promise<void> => {
  try {
    if (await readFile(path, 'utf8') === contents) {
      await rm(path, { force: true });
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
};

const yieldToFilesystem = async (): Promise<void> => {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
};

const recoveryContentsFor = (owner: DevLockOwner): string => `${stableJson({ owner })}\n`;

const acquireRecoveryGate = async (
  recoveryPath: string,
  owner: DevLockOwner,
  probeProcess: (pid: number) => boolean,
): Promise<string> => {
  const contents = recoveryContentsFor(owner);
  for (;;) {
    if (await writeCompleteExclusive(recoveryPath, contents, owner.nonce)) return contents;

    let currentContents: string;
    try {
      currentContents = await readFile(recoveryPath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
    const recovery = parseRecoveryRecord(currentContents);
    if (recovery === undefined) {
      throw new DevLockError(
        'DEV_LOCK_INVALID',
        'The development lock recovery gate does not contain valid owner metadata.',
      );
    }
    if (probeProcess(recovery.owner.pid)) {
      await yieldToFilesystem();
      continue;
    }
    await removeIfOwned(recoveryPath, currentContents);
  }
};

export class DevLock {
  readonly #contents: string;
  readonly #path: string;
  readonly #probeProcess: (pid: number) => boolean;
  readonly #recoveryPath: string;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    path: string,
    recoveryPath: string,
    contents: string,
    owner: DevLockOwner,
    probeProcess: (pid: number) => boolean,
  ) {
    this.#path = path;
    this.#probeProcess = probeProcess;
    this.#recoveryPath = recoveryPath;
    this.#contents = contents;
    this.owner = owner;
  }

  readonly owner: DevLockOwner;

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise !== undefined) return this.#closePromise;

    const closePromise = (async () => {
      const recoveryContents = await acquireRecoveryGate(this.#recoveryPath, this.owner, this.#probeProcess);
      try {
        await removeIfOwned(this.#path, this.#contents);
      } finally {
        await removeIfOwned(this.#recoveryPath, recoveryContents);
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
  await mkdir(directoryPath, { recursive: true });
  if (!(await lstat(directoryPath)).isDirectory()) {
    throw new DevLockError(
      'DEV_LOCK_INVALID',
      'The .agent-bundle path must be a directory contained by the project.',
    );
  }

  for (;;) {
    if (await writeCompleteExclusive(path, contents, owner.nonce)) {
      return new DevLock(path, recoveryPath, contents, owner, probeProcess);
    }

    let currentContents: string;
    try {
      currentContents = await readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
    const currentOwner = parseOwner(currentContents);
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

    const recoveryContents = await acquireRecoveryGate(recoveryPath, owner, probeProcess);
    try {
      let currentDuringRecovery: string;
      try {
        currentDuringRecovery = await readFile(path, 'utf8');
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (currentDuringRecovery !== currentContents) continue;
      const ownerDuringRecovery = parseOwner(currentDuringRecovery);
      if (ownerDuringRecovery === undefined) {
        throw new DevLockError(
          'DEV_LOCK_INVALID',
          'The existing development lock does not contain valid owner metadata.',
        );
      }
      if (probeProcess(ownerDuringRecovery.pid)) continue;
      await removeIfOwned(path, currentContents);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    } finally {
      await removeIfOwned(recoveryPath, recoveryContents);
    }
  }
};
