import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isErrno } from '../core/errors.ts';
import {
  installReceiptFile,
  pruneEmptyDirectory,
  type InstallReceipt,
} from './receipt.ts';
import type { UninstallReceiptReport, UninstallReceiptStatus } from './uninstall.ts';

const deepestFirst = (directories: readonly string[]): readonly string[] =>
  [...directories].sort((left, right) => right.length - left.length || left.localeCompare(right));

export const receiptReport = (path: string, receipt: InstallReceipt | undefined, status: UninstallReceiptStatus): UninstallReceiptReport =>
  Object.freeze({
    ...(receipt === undefined ? {} : {
      contentHash: receipt.contentHash,
      format: receipt.format,
      installedAt: receipt.installedAt,
      version: receipt.version,
    }),
    path,
    status,
  });

/** Removes empty directories deepest first; reports the ones actually removed. */
export const pruneDirectories = async (paths: readonly string[]): Promise<readonly string[]> => {
  const removed: string[] = [];
  for (const path of deepestFirst(paths)) {
    if (await pruneEmptyDirectory(path)) removed.push(path);
  }
  return removed;
};

export const wouldPrune = async (path: string, gone: Set<string>): Promise<boolean> => {
  let entries: readonly string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
  if (!entries.every((entry) => gone.has(join(path, entry)))) return false;
  gone.add(path);
  return true;
};

/** Computes the directory set pruneDirectories would remove once removedPaths is gone. */
export const simulatePrune = async (paths: readonly string[], removedPaths: ReadonlySet<string>): Promise<readonly string[]> => {
  const gone = new Set(removedPaths);
  const pruned: string[] = [];
  for (const path of deepestFirst(paths)) {
    if (await wouldPrune(path, gone)) pruned.push(path);
  }
  return pruned;
};

/** Lists unowned entries an uninstall retains without following retained symlinks. */
export const listRetained = async (
  root: string,
  owned: ReadonlySet<string>,
  ownedDirectories: ReadonlySet<string>,
): Promise<readonly string[]> => {
  const retained: string[] = [];
  const visit = async (relativePath: string): Promise<number> => {
    let entries: readonly string[];
    try {
      entries = (await readdir(join(root, relativePath))).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return 0;
      throw error;
    }
    let kept = 0;
    for (const name of entries) {
      const child = relativePath === '' ? name : `${relativePath}/${name}`;
      if (relativePath === '' && name === installReceiptFile) continue;
      const metadata = await lstat(join(root, child));
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        const below = await visit(child);
        if (below === 0 && !ownedDirectories.has(child)) retained.push(`${child}/`);
        kept += below === 0 && !ownedDirectories.has(child) ? 1 : below;
        continue;
      }
      if (!owned.has(child)) {
        retained.push(child);
        kept += 1;
      }
    }
    return kept;
  };
  await visit('');
  return Object.freeze(retained);
};
