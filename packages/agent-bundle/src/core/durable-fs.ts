import { link, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isErrno, isTolerableWin32SyncError } from './errors.ts';

/**
 * Filesystem durability primitives behind the dev lock's link-published
 * owner document: file and directory fsync with the documented Windows
 * directory tolerance, and staged hard-link publication.
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
