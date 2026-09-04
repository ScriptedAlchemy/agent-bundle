import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { digest } from '../core/digest.ts';
import type { EvalFixturePlan } from './fixtures.ts';

export interface WorkspaceChange {
  readonly digest: string;
  readonly id: string;
  readonly kind: 'added' | 'modified' | 'removed';
}

export interface WorkspaceDiff {
  readonly changes: readonly WorkspaceChange[];
  readonly truncated?: true;
}

export interface WorkspaceDiffOptions {
  readonly fileByteLimit?: number;
  readonly limit?: number;
  readonly plan: EvalFixturePlan;
  readonly scanLimit?: number;
  readonly totalByteLimit?: number;
  readonly workspace: string;
}

const defaultLimit = 128;
const defaultFileByteLimit = 16 * 1024 * 1024;
const defaultScanLimit = 4_096;
const defaultTotalByteLimit = 64 * 1024 * 1024;

const positiveBound = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between 1 and ${maximum}.`);
  }
  return value;
};

/**
 * Stays on `node:fs` (see `docs/effect-conventions.md`, keep-raw list): the
 * hash is taken through an `O_NOFOLLOW` descriptor whose `dev`/`ino`/`nlink`
 * identity is checked against the `lstat` that discovered it. The pinned
 * `FileSystem.open` accepts only string flags and has no `lstat`.
 */
const sha256 = async (path: string, byteLimit: number): Promise<Readonly<{
  readonly bytes: number;
  readonly digest?: string;
  readonly truncated: boolean;
}>> => {
  const discovered = await lstat(path);
  if (!discovered.isFile() || discovered.isSymbolicLink() || discovered.nlink !== 1) {
    return Object.freeze({ bytes: 0, truncated: true });
  }
  // The no-follow descriptor is the identity being hashed; a workspace cannot
  // swap a discovered file to a symlink between metadata validation and read.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || metadata.nlink !== 1 ||
      metadata.dev !== discovered.dev || metadata.ino !== discovered.ino ||
      metadata.size > byteLimit
    ) {
      return Object.freeze({ bytes, truncated: true });
    }
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > byteLimit) return Object.freeze({ bytes, truncated: true });
      hash.update(chunk);
    }
    return Object.freeze({ bytes, digest: hash.digest('hex'), truncated: false });
  } finally {
    await handle.close();
  }
};

const workspaceEntries = async (
  workspace: string,
  scanLimit: number,
): Promise<Readonly<{ readonly files: readonly string[]; readonly truncated: boolean }>> => {
  const files: string[] = [];
  const directories: Array<Readonly<{ readonly absolute: string; readonly relative: string }>> = [
    Object.freeze({ absolute: workspace, relative: '' }),
  ];
  let visited = 0;

  while (directories.length > 0) {
    const directory = directories.pop()!;
    const handle = await opendir(directory.absolute);
    try {
      while (true) {
        const entry = await handle.read();
        if (entry === null) break;
        const relative = directory.relative.length === 0 ? entry.name : `${directory.relative}/${entry.name}`;
        if (relative === '.git' || relative.startsWith('.git/')) continue;
        if (visited >= scanLimit) return Object.freeze({ files: Object.freeze(files), truncated: true });
        visited += 1;
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile()) {
          files.push(relative);
          continue;
        }
        if (entry.isDirectory()) {
          directories.push(Object.freeze({ absolute: join(directory.absolute, entry.name), relative }));
        }
      }
    } finally {
      await handle.close();
    }
  }

  return Object.freeze({ files: Object.freeze(files), truncated: false });
};

/**
 * Compares a trial-owned workspace to its planned fixture without retaining a
 * file name, absolute path, or file content in evidence. The opaque ids remain
 * stable for the same relative workspace change and exact bytes.
 */
export const workspaceDiff = async (options: WorkspaceDiffOptions): Promise<WorkspaceDiff> => {
  const limit = options.limit ?? defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_096) {
    throw new TypeError('Workspace diff limit must be a safe integer between 1 and 4096.');
  }
  const fileByteLimit = positiveBound(options.fileByteLimit ?? defaultFileByteLimit, 'Workspace diff file byte limit', 1024 * 1024 * 1024);
  const scanLimit = positiveBound(options.scanLimit ?? defaultScanLimit, 'Workspace diff scan limit', 65_536);
  const totalByteLimit = positiveBound(options.totalByteLimit ?? defaultTotalByteLimit, 'Workspace diff total byte limit', 1024 * 1024 * 1024);
  const baseline = new Map(options.plan.entries.map((entry) => [entry.path, entry.sha256]));
  const seen = new Set<string>();
  const changes: WorkspaceChange[] = [];
  let truncated = false;
  let totalBytes = 0;
  const add = (kind: WorkspaceChange['kind'], path: string, changeDigest: string): void => {
    if (changes.length >= limit) {
      truncated = true;
      return;
    }
    changes.push(Object.freeze({
      digest: changeDigest,
      id: digest({ digest: changeDigest, kind, path }),
      kind,
    }));
  };

  const discovered = await workspaceEntries(options.workspace, scanLimit);
  for (const path of [...discovered.files].sort((left, right) => left.localeCompare(right))) {
    if (truncated) break;
    const absolute = join(options.workspace, path);
    const remainingBytes = totalByteLimit - totalBytes;
    const hashed = await sha256(absolute, Math.min(fileByteLimit, remainingBytes));
    totalBytes += hashed.bytes;
    if (hashed.truncated || hashed.digest === undefined) {
      truncated = true;
      break;
    }
    const current = hashed.digest;
    seen.add(path);
    const expected = baseline.get(path);
    if (expected === undefined) add('added', path, current);
    else if (expected !== current) add('modified', path, current);
  }
  for (const [path, expected] of [...baseline.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (truncated || discovered.truncated) break;
    if (!seen.has(path)) add('removed', path, expected);
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    ...(truncated || discovered.truncated ? { truncated: true as const } : {}),
  });
};
