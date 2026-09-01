import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { publishFileByLink } from '../core/durable-fs.ts';
import { CodedError, isErrno } from '../core/errors.ts';
import { acquireOwnerLockFile, isProcessAlive, ownerLockRaceLost } from '../core/owner-lock.ts';

export interface DevLockOwner {
  readonly createdAt: string;
  readonly nonce: string;
  readonly pid: number;
  readonly projectRoot: string;
  readonly url?: string;
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

const isLoopbackServerUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') &&
      parsed.origin === value;
  } catch {
    return false;
  }
};

const parseOwnerValue = (value: unknown, projectRoot: string): DevLockOwner | undefined => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const parsed = value as Partial<DevLockOwner>;
    const pid = parsed.pid;
    const hasUrl = Object.hasOwn(parsed, 'url');
    const url = hasUrl && isLoopbackServerUrl(parsed.url) ? parsed.url : undefined;
    if (
      Object.keys(parsed).length !== (hasUrl ? 5 : 4) ||
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
      parsed.projectRoot !== projectRoot ||
      (hasUrl && url === undefined)
    ) {
      return undefined;
    }
    if (new Date(parsed.createdAt).toISOString() !== parsed.createdAt) return undefined;
    return Object.freeze({
      createdAt: parsed.createdAt,
      nonce: parsed.nonce,
      pid,
      projectRoot: parsed.projectRoot,
      ...(url === undefined ? {} : { url }),
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

interface DevServerUrlRecord {
  readonly nonce: string;
  readonly url: string;
}

const serverUrlPathFor = (path: string, nonce: string): string =>
  join(dirname(path), `.${basename(path)}.server-${createHash('sha256').update(nonce).digest('hex')}`);

const serverUrlContentsFor = (owner: DevLockOwner, url: string): string =>
  `${stableJson({ nonce: owner.nonce, url } satisfies DevServerUrlRecord)}\n`;

const parseServerUrl = (contents: string, owner: DevLockOwner): string | undefined => {
  try {
    const value: unknown = JSON.parse(contents);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Partial<DevServerUrlRecord>;
    if (
      Object.keys(record).length !== 2 ||
      record.nonce !== owner.nonce ||
      !isLoopbackServerUrl(record.url)
    ) return undefined;
    const canonical = `${stableJson({ nonce: record.nonce, url: record.url })}\n`;
    return contents === canonical ? record.url : undefined;
  } catch {
    return undefined;
  }
};

const readServerUrl = async (
  storage: DevLockStorage,
  path: string,
  owner: DevLockOwner,
): Promise<string | undefined> => {
  try {
    return parseServerUrl(await storage.readFile(serverUrlPathFor(path, owner.nonce), 'utf8'), owner);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
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

const candidateCleanupFailedMessage = 'Development lock candidate cleanup failed.';

const writeCompleteExclusive = async (
  storage: DevLockStorage,
  path: string,
  contents: string,
  nonce: string,
): Promise<boolean> => {
  const candidate = candidatePathFor(path, nonce);
  try {
    return await publishFileByLink(path, contents, {
      link: storage.link,
      open: storage.open,
      openExclusive: storage.open,
      publicationCleanupFailed: 'Development lock publication and cleanup both failed.',
      remove: storage.remove,
      // Content-conditional: only this acquisition's published record is ever
      // unlinked, never a lock another process published after winning a race.
      rollback: async () => { await removeIfOwned(storage, path, contents); },
      stagingCleanupFailed: candidateCleanupFailedMessage,
      stagingPath: candidate,
    });
  } catch (error) {
    // publishFileByLink runs the rollback only when a primary failure follows
    // a successful link; a candidate-cleanup-only failure still leaves the
    // published lock behind with no handle to release it. Unpublish both
    // records content-conditionally so a failed acquisition leaks nothing —
    // a raced winner's differing contents are never touched.
    if (!(error instanceof AggregateError) || error.message !== candidateCleanupFailedMessage) throw error;
    const rollbackFailures: unknown[] = [];
    for (const record of [path, candidate]) {
      try {
        await removeIfOwned(storage, record, contents);
      } catch (rollbackFailure) {
        rollbackFailures.push(rollbackFailure);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        'Development lock candidate cleanup and rollback both failed.',
        { cause: error },
      );
    }
    throw error;
  }
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
  return acquireOwnerLockFile<string>({
    // Acquisition never concedes: it waits out live holders and retries until
    // the exclusive create wins or the contention judge throws, so the
    // exhausted error is unreachable.
    attempts: Number.POSITIVE_INFINITY,
    // A lost link race routes to the contention judge via the sentinel.
    create: async () =>
      await writeCompleteExclusive(storage, recoveryPath, contents, owner.nonce)
        ? contents
        : ownerLockRaceLost,
    exhausted: () =>
      new DevLockError('DEV_LOCK_HELD', 'The development lock recovery gate could not be acquired.'),
    onContention: async () => {
      let currentContents: string;
      try {
        currentContents = await storage.readFile(recoveryPath, 'utf8');
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return undefined;
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
        return undefined;
      }
      await removeIfOwned(storage, recoveryPath, currentContents);
      return undefined;
    },
  });
};

export class DevLock {
  readonly #contents: string;
  #owner: DevLockOwner;
  readonly #path: string;
  readonly #probeProcess: (pid: number) => boolean;
  readonly #recoveryPath: string;
  readonly #storage: DevLockStorage;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #publishPromise: Promise<void> | undefined;
  #publishingUrl: string | undefined;

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
    this.#owner = owner;
  }

  get owner(): DevLockOwner {
    return this.#owner;
  }

  publishServerUrl(url: string): Promise<void> {
    if (!isLoopbackServerUrl(url)) return Promise.reject(new TypeError('Development server URL must be a loopback HTTP origin.'));
    if (this.#closed || this.#closePromise !== undefined) return Promise.reject(new Error('Development lock is closing.'));
    if (this.#owner.url === url) return Promise.resolve();
    if (this.#owner.url !== undefined) return Promise.reject(new Error('Development lock already published a different server URL.'));
    if (this.#publishPromise !== undefined) {
      return this.#publishingUrl === url
        ? this.#publishPromise
        : Promise.reject(new Error('Development lock is publishing a different server URL.'));
    }

    const owner = Object.freeze({ ...this.#owner, url });
    const serverUrlPath = serverUrlPathFor(this.#path, this.#owner.nonce);
    const serverUrlContents = serverUrlContentsFor(this.#owner, url);
    const publishPromise = (async () => {
      const currentContents = await this.#storage.readFile(this.#path, 'utf8');
      if (currentContents !== this.#contents) {
        throw new DevLockError('DEV_LOCK_INVALID', 'Development lock ownership changed before its server URL could be published.');
      }
      if (!(await writeCompleteExclusive(this.#storage, serverUrlPath, serverUrlContents, this.#owner.nonce))) {
        const existing = await this.#storage.readFile(serverUrlPath, 'utf8');
        if (existing !== serverUrlContents) {
          throw new DevLockError('DEV_LOCK_INVALID', 'The development server URL record belongs to a different owner.');
        }
      }
      if (await this.#storage.readFile(this.#path, 'utf8') !== this.#contents) {
        await removeIfOwned(this.#storage, serverUrlPath, serverUrlContents);
        throw new DevLockError('DEV_LOCK_INVALID', 'Development lock ownership changed while its server URL was published.');
      }
      this.#owner = owner;
    })();
    this.#publishingUrl = url;
    this.#publishPromise = publishPromise;
    void publishPromise.then(
      () => {
        if (this.#publishPromise === publishPromise) {
          this.#publishPromise = undefined;
          this.#publishingUrl = undefined;
        }
      },
      () => {
        if (this.#publishPromise === publishPromise) {
          this.#publishPromise = undefined;
          this.#publishingUrl = undefined;
        }
      },
    );
    return publishPromise;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise !== undefined) return this.#closePromise;

    const pendingPublication = this.#publishPromise;
    const closePromise = (async () => {
      await pendingPublication?.catch(() => undefined);
      const recoveryContents = await acquireRecoveryGate(
        this.#storage,
        this.#recoveryPath,
        this.owner,
        this.#probeProcess,
      );
      try {
        await removeIfOwned(this.#storage, this.#path, this.#contents);
        await removeIfOwned(this.#storage, candidatePathFor(this.#path, this.owner.nonce), this.#contents);
        await this.#storage.remove(serverUrlPathFor(this.#path, this.owner.nonce), { force: true });
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
  const probeProcess = options.probeProcess ?? isProcessAlive;
  const recoveryPath = `${path}${recoverySuffix}`;
  const directoryPath = dirname(path);
  await storage.mkdir(directoryPath, { recursive: true });
  if (!(await storage.lstat(directoryPath)).isDirectory()) {
    throw new DevLockError(
      'DEV_LOCK_INVALID',
      'The .agent-bundle path must be a directory contained by the project.',
    );
  }

  return acquireOwnerLockFile<DevLock>({
    // Acquisition never concedes: it retries until the exclusive create wins
    // or the contention judge throws, so the exhausted error is unreachable.
    attempts: Number.POSITIVE_INFINITY,
    // A lost link race routes to the contention judge via the sentinel.
    create: async () =>
      await writeCompleteExclusive(storage, path, contents, owner.nonce)
        ? new DevLock(path, recoveryPath, contents, owner, probeProcess, storage)
        : ownerLockRaceLost,
    exhausted: () =>
      new DevLockError('DEV_LOCK_HELD', 'The development lock could not be acquired.'),
    onContention: async () => {
      let currentContents: string;
      try {
        currentContents = await storage.readFile(path, 'utf8');
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return undefined;
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
        const serverUrl = await readServerUrl(storage, path, currentOwner);
        const reportedOwner = serverUrl === undefined
          ? currentOwner
          : Object.freeze({ ...currentOwner, url: serverUrl });
        const ownerDetails = serverUrl === undefined
          ? `pid ${currentOwner.pid}`
          : `pid ${currentOwner.pid}, ${serverUrl}`;
        throw new DevLockError(
          'DEV_LOCK_HELD',
          `Another agent-bundle dev process owns this project (${ownerDetails}).`,
          reportedOwner,
        );
      }

      const recoveryContents = await acquireRecoveryGate(storage, recoveryPath, owner, probeProcess);
      try {
        let currentDuringRecovery: string;
        try {
          currentDuringRecovery = await storage.readFile(path, 'utf8');
        } catch (error) {
          if (isErrno(error, 'ENOENT')) return undefined;
          throw error;
        }
        if (currentDuringRecovery !== currentContents) return undefined;
        const ownerDuringRecovery = parseOwner(currentDuringRecovery, projectRoot);
        if (ownerDuringRecovery === undefined) {
          throw new DevLockError(
            'DEV_LOCK_INVALID',
            'The existing development lock does not contain valid owner metadata.',
          );
        }
        if (probeProcess(ownerDuringRecovery.pid)) return undefined;
        await removeIfOwned(storage, path, currentContents);
        await storage.remove(serverUrlPathFor(path, ownerDuringRecovery.nonce), { force: true });
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
      return undefined;
    },
  });
};
