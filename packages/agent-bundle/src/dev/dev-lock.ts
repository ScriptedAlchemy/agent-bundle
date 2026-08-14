import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { stableJson } from '../core/digest.ts';

export interface DevLockOwner {
  readonly createdAt: string;
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
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof parsed.projectRoot !== 'string'
    ) {
      return undefined;
    }
    return Object.freeze({
      createdAt: parsed.createdAt,
      pid,
      projectRoot: parsed.projectRoot,
      version: 1,
    });
  } catch {
    return undefined;
  }
};

export class DevLock {
  readonly #contents: string;
  readonly #path: string;
  #closed = false;

  constructor(path: string, contents: string, owner: DevLockOwner) {
    this.#path = path;
    this.#contents = contents;
    this.owner = owner;
  }

  readonly owner: DevLockOwner;

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (await readFile(this.#path, 'utf8') === this.#contents) {
        await rm(this.#path, { force: true });
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
}

/** Acquires the single writer lock for one project's development epoch store. */
export const acquireDevLock = async (options: DevLockOptions): Promise<DevLock> => {
  const projectRoot = resolve(options.projectRoot);
  const path = join(projectRoot, '.agent-bundle', devLockName);
  const owner: DevLockOwner = Object.freeze({
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    pid: process.pid,
    projectRoot,
    version: 1,
  });
  const contents = `${stableJson(owner)}\n`;
  const probeProcess = options.probeProcess ?? isProcessRunning;
  await mkdir(dirname(path), { recursive: true });

  for (;;) {
    try {
      const handle = await open(path, 'wx');
      try {
        await writeFile(handle, contents, 'utf8');
      } finally {
        await handle.close();
      }
      return new DevLock(path, contents, owner);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
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

    try {
      if (await readFile(path, 'utf8') !== currentContents) continue;
      await rm(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
  }
};
