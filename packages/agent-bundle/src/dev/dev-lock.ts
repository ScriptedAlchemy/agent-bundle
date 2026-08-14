import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { stableJson } from '../core/digest.ts';

export interface DevLockOwner {
  readonly createdAt: string;
  readonly nonce: string;
  readonly pid: number;
  readonly projectRoot: string;
  readonly version: 1;
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

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
};

const parseOwner = (value: string): DevLockOwner | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<DevLockOwner>;
    const pid = parsed.pid;
    if (
      parsed.version !== 1 ||
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
      version: 1,
    });
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

export class DevLock {
  readonly #contents: string;
  readonly #path: string;
  readonly #recoveryPath: string;
  #closed = false;

  constructor(path: string, recoveryPath: string, contents: string, owner: DevLockOwner) {
    this.#path = path;
    this.#recoveryPath = recoveryPath;
    this.#contents = contents;
    this.owner = owner;
  }

  readonly owner: DevLockOwner;

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const recoveryContents = `${stableJson({ owner: this.owner, version: 1 })}\n`;
    while (!await writeCompleteExclusive(this.#recoveryPath, recoveryContents, this.owner.nonce)) {
      await yieldToFilesystem();
    }
    try {
      await removeIfOwned(this.#path, this.#contents);
    } finally {
      await removeIfOwned(this.#recoveryPath, recoveryContents);
    }
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
    version: 1,
  });
  const contents = `${stableJson(owner)}\n`;
  const probeProcess = options.probeProcess ?? isProcessRunning;
  const recoveryPath = `${path}${recoverySuffix}`;
  await mkdir(dirname(path), { recursive: true });

  for (;;) {
    if (await writeCompleteExclusive(path, contents, owner.nonce)) {
      return new DevLock(path, recoveryPath, contents, owner);
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

    const recoveryContents = `${stableJson({ owner, version: 1 })}\n`;
    if (!await writeCompleteExclusive(recoveryPath, recoveryContents, owner.nonce)) {
      await yieldToFilesystem();
      continue;
    }
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
