import { Buffer } from 'node:buffer';
import { closeSync, constants, fsyncSync, openSync } from 'node:fs';
import { link, lstat, open, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isErrno, isTolerableWin32SyncError } from './errors.ts';
import { isInsideOrEqual, sameFile } from './paths.ts';
import { parseJsonWithoutDuplicateKeys } from './strict-json.ts';

/**
 * Shared filesystem durability toolkit for the playground, eval run, and
 * epoch stores. Every primitive here parameterizes only the differences the
 * stores genuinely have (error vocabularies, test-hook phases, injectable
 * handle opens) while keeping one implementation of each durability
 * algorithm: atomic temp+rename JSON publication, staged hard-link
 * publication, file and directory fsync with the documented Windows
 * directory tolerance, pinned single-link file verification, and
 * torn-tail-tolerant JSONL decoding.
 */

/** Minimal handle surface the async sync primitives need; `FileHandle` satisfies it. */
export interface DurableHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Handle-open seam so stores can inject deterministic durability failures. */
export type DurableHandleOpen = (path: string, flags: 'r') => Promise<DurableHandle>;

export interface SyncPathOptions {
  /** Directories tolerate the documented Windows FlushFileBuffers gaps; files never do. */
  readonly directory?: boolean;
  /** Defaults to `fs/promises.open`. */
  readonly open?: DurableHandleOpen;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** Fsyncs one path through an (optionally injected) read handle. */
export const syncPath = async (path: string, options: SyncPathOptions = {}): Promise<void> => {
  const openHandle: DurableHandleOpen = options.open ?? open;
  const handle = await openHandle(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Windows has no public directory-fsync primitive. Only documented
    // directory FlushFileBuffers capability failures are tolerated here;
    // opening a directory and every retained regular-file sync still fail.
    if (options.directory === true && isTolerableWin32SyncError(options.platform ?? process.platform, error)) return;
    throw error;
  } finally {
    await handle.close();
  }
};

export interface SyncDirectorySyncOptions {
  /** Runs after the descriptor opens, immediately before the fsync attempt. */
  readonly beforeFsync?: () => void;
  /** Runs immediately before the directory descriptor opens. */
  readonly beforeOpen?: () => void;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** Synchronous directory fsync with the same Windows tolerance as {@link syncPath}. */
export const syncDirectorySync = (path: string, options: SyncDirectorySyncOptions = {}): void => {
  options.beforeOpen?.();
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    options.beforeFsync?.();
    fsyncSync(descriptor);
  } catch (error) {
    // See syncPath: only documented Windows directory FlushFileBuffers
    // capability failures are tolerated.
    if (isTolerableWin32SyncError(options.platform ?? process.platform, error)) return;
    throw error;
  } finally {
    closeSync(descriptor);
  }
};

export interface AtomicJsonWriteOptions {
  /** Caller-named staging path; it must share a directory with the destination. */
  readonly temporaryPath: string;
  readonly open?: DurableHandleOpen;
  readonly platform?: NodeJS.Platform;
}

/**
 * Atomically publishes a serialized JSON document: write to the staging path,
 * fsync it, rename it over the destination, then fsync the directory so the
 * rename itself is durable. The staging file never survives, even on failure.
 */
export const writeJsonFileAtomically = async (
  path: string,
  serialized: string,
  options: AtomicJsonWriteOptions,
): Promise<void> => {
  const sync = { open: options.open, platform: options.platform };
  try {
    await writeFile(options.temporaryPath, serialized, 'utf8');
    await syncPath(options.temporaryPath, sync);
    await rename(options.temporaryPath, path);
    await syncPath(dirname(path), { ...sync, directory: true });
  } finally {
    await rm(options.temporaryPath, { force: true });
  }
};

/** Staging handle surface the link publication needs; `FileHandle` satisfies it. */
export interface DurableStagingHandle extends DurableHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
}

/** Exclusive-create staging seam matching `fs/promises.open(path, 'wx', mode)`. */
export type DurableStagingOpen = (path: string, flags: 'wx', mode: number) => Promise<DurableStagingHandle>;

export interface PublishFileByLinkOptions {
  /** Caller-named staging path; it must share a directory with the destination. */
  readonly stagingPath: string;
  /** Defaults to `fs/promises.link`. */
  readonly link?: (existingPath: string, newPath: string) => Promise<void>;
  /** Defaults to `fs/promises.open`; opens the destination-directory fsync handle. */
  readonly open?: DurableHandleOpen;
  /** Defaults to `fs/promises.open`; performs the exclusive staging create. */
  readonly openExclusive?: DurableStagingOpen;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Store-specific aggregate message when publication and cleanup both fail. */
  readonly publicationCleanupFailed: string;
  /** Defaults to `fs/promises.rm`; must tolerate a missing staging file. */
  readonly remove?: (path: string, options: { readonly force: true }) => Promise<void>;
  /** Undoes an already-linked publication when the directory fsync fails; never runs for a lost link race. */
  readonly rollback?: () => Promise<void>;
  /** Store-specific aggregate message when only staging cleanup fails. */
  readonly stagingCleanupFailed: string;
}

/**
 * Durably publishes an immutable file through hard-link publication: write
 * and fsync a caller-named staging file, `link()` it to the destination —
 * tolerating EEXIST so a raced winner is adopted rather than replaced — then
 * fsync the directory so the linked (or adopted) publication is durable. The
 * staging file never survives, and a staging-cleanup failure fails the
 * publication even after a successful link. Returns true only when this call
 * created the destination link.
 */
export const publishFileByLink = async (
  path: string,
  contents: string,
  options: PublishFileByLinkOptions,
): Promise<boolean> => {
  const linkFile = options.link ?? link;
  const openStaging: DurableStagingOpen = options.openExclusive ?? open;
  const remove = options.remove ?? rm;
  let handle: DurableStagingHandle | undefined;
  let created = false;
  let primary: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    handle = await openStaging(options.stagingPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await linkFile(options.stagingPath, path);
      created = true;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    await syncPath(dirname(path), { directory: true, open: options.open, platform: options.platform });
  } catch (error) {
    primary = error;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await remove(options.stagingPath, { force: true }); }
    catch (error) { cleanupFailures.push(error); }
    if (primary !== undefined && created) {
      try { await options.rollback?.(); }
      catch (error) { cleanupFailures.push(error); }
    }
  }
  if (primary !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError([primary, ...cleanupFailures], options.publicationCleanupFailed, { cause: primary });
    }
    throw primary;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, options.stagingCleanupFailed, { cause: cleanupFailures[0] });
  }
  return created;
};

export interface WriteNewPinnedFileOptions {
  /** Runs after the fsync succeeds so callers can mark the file recoverable. */
  readonly afterFsync?: () => void;
  readonly beforeFsync?: () => void | Promise<void>;
  readonly beforeWrite?: () => void | Promise<void>;
  /** Store-specific error for a create that did not pin a singly linked regular file. */
  readonly invalid: () => Error;
}

/**
 * Exclusively creates a new durable file (O_EXCL, no symlink following),
 * proves the created handle pins a singly linked regular file, then writes
 * and fsyncs its contents.
 */
export const writeNewPinnedFile = async (
  path: string,
  contents: string,
  options: WriteNewPinnedFileOptions,
): Promise<void> => {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw options.invalid();
    await options.beforeWrite?.();
    await handle.writeFile(contents, 'utf8');
    await options.beforeFsync?.();
    await handle.sync();
    options.afterFsync?.();
  } finally {
    await handle.close();
  }
};

export interface OpenPinnedContainedFileOptions {
  readonly flags: number;
  /** Store-specific error for a path that is not a singly linked contained regular file. */
  readonly invalid: () => Error;
  readonly name: string;
  readonly root: string;
}

/**
 * Opens `name` inside `root` and proves that the handle and the path name the
 * same singly linked regular file (matching dev/ino, nlink 1, no symlink)
 * whose real path stays contained under `root`. The handle is closed when any
 * check fails.
 */
export const openPinnedContainedFile = async (options: OpenPinnedContainedFileOptions): Promise<FileHandle> => {
  const path = join(options.root, options.name);
  const handle = await open(path, options.flags | constants.O_NOFOLLOW);
  try {
    const [fileStat, pathStat] = await Promise.all([handle.stat(), lstat(path)]);
    const resolved = await realpath(path);
    if (!fileStat.isFile()
      || !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || fileStat.nlink !== 1
      || pathStat.nlink !== 1
      || fileStat.dev !== pathStat.dev
      || fileStat.ino !== pathStat.ino
      || !isInsideOrEqual(options.root, resolved)
      || basename(resolved) !== options.name) {
      throw options.invalid();
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export interface ReadPinnedFileOptions {
  /** Store-specific error for a file that changed between lstat and the opened handle. */
  readonly changedWhileOpening: () => Error;
  /** Store-specific error for a file whose identity or size drifted across the read. */
  readonly changedWhileReading: () => Error;
  /** Upper bound on the pinned file's size in bytes. */
  readonly maximumBytes: number;
  /** Store-specific error for a symlinked, multiply linked, or oversized path. */
  readonly unsafe: () => Error;
  /** Re-verifies caller-tracked ancestor directory identities before and after the read. */
  readonly verifyAncestry?: () => Promise<void>;
}

/**
 * Reads a whole pinned file while proving the path, the open descriptor, and
 * the post-read stats all describe the same singly linked regular file whose
 * size never changed — the shared TOCTOU defense for record reads.
 */
export const readPinnedFile = async (path: string, options: ReadPinnedFileOptions): Promise<string> => {
  await options.verifyAncestry?.();
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > options.maximumBytes) {
    throw options.unsafe();
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptor = await file.stat();
    if (!descriptor.isFile() || descriptor.nlink !== 1 || descriptor.size > options.maximumBytes || !sameFile(before, descriptor)) {
      throw options.changedWhileOpening();
    }
    const bytes = await file.readFile({ encoding: 'utf8' });
    const [after, final] = await Promise.all([lstat(path), file.stat()]);
    await options.verifyAncestry?.();
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || !sameFile(before, after) || !sameFile(descriptor, final) ||
      final.size !== descriptor.size || Buffer.byteLength(bytes, 'utf8') !== descriptor.size) {
      throw options.changedWhileReading();
    }
    return bytes;
  } finally {
    await file.close();
  }
};

export interface TornTailJsonlOptions<Record extends { readonly sequence: number }> {
  /** Decodes one complete strict-parsed line, throwing the store's error for invalid records. */
  readonly decode: (value: unknown, index: number) => Record;
  /** Store-specific error for an empty complete line. */
  readonly emptyRecord: () => Error;
  /** Store-specific error for a complete line that is not strict JSON. */
  readonly malformedRecord: () => Error;
  /** Store-specific error when a decoded record's sequence is not exactly index + 1. */
  readonly sequenceViolation: () => Error;
}

export interface TornTailJsonlRead<Record> {
  /** Present when the log ends in a torn, incomplete final append. */
  readonly incompleteTrailingRecord?: string;
  readonly records: readonly Record[];
}

/**
 * Decodes a JSONL journal tolerating exactly one torn trailing append: split
 * on newlines, drop the trailing fragment (or the empty string after a final
 * newline), reject empty complete lines, strict-parse each record without
 * duplicate keys, and verify sequences are exactly 1 through N.
 */
export const readTornTailJsonl = <Record extends { readonly sequence: number }>(
  contents: string,
  options: TornTailJsonlOptions<Record>,
): TornTailJsonlRead<Record> => {
  const lines = contents.split('\n');
  // The final element is the empty string after a trailing newline or a torn tail append; both are dropped.
  const trailing = lines.pop() ?? '';
  const records: Record[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) throw options.emptyRecord();
    let parsed: unknown;
    try {
      parsed = parseJsonWithoutDuplicateKeys(line);
    } catch {
      throw options.malformedRecord();
    }
    const record = options.decode(parsed, index);
    if (record.sequence !== index + 1) throw options.sequenceViolation();
    records.push(record);
  }
  return Object.freeze({
    records: Object.freeze(records),
    ...(trailing.length === 0 ? {} : { incompleteTrailingRecord: trailing }),
  });
};
