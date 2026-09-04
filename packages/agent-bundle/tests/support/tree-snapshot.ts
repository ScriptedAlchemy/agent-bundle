import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A byte-level picture of a directory tree: every entry (files by sha256 and
 * mode bits, directories, symlink targets), sorted, POSIX-relative to the
 * root. Two snapshots are equal exactly when the trees are byte-identical
 * (timestamps excepted), which is what the uninstall proofs compare a home
 * against before install and after uninstall.
 */
export type TreeSnapshot = ReadonlyMap<string, string>;

export const snapshotTree = async (root: string): Promise<TreeSnapshot> => {
  const entries = new Map<string, string>();
  const visit = async (relativePath: string): Promise<void> => {
    let names: readonly string[];
    try {
      names = (await readdir(join(root, relativePath))).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      const child = relativePath === '' ? name : `${relativePath}/${name}`;
      const path = join(root, child);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        entries.set(child, `link ${await readlink(path)}`);
      } else if (metadata.isDirectory()) {
        entries.set(child, 'dir');
        await visit(child);
      } else if (metadata.isFile()) {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex');
        entries.set(child, `file ${digest} ${(metadata.mode & 0o777).toString(8)}`);
      } else {
        entries.set(child, 'special');
      }
    }
  };
  await visit('');
  return entries;
};

export interface TreeSnapshotDifference {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

/** Entries present only after (`added`), only before (`removed`), or with different bytes (`changed`). */
export const diffTreeSnapshots = (before: TreeSnapshot, after: TreeSnapshot): TreeSnapshotDifference => {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, description] of after) {
    const previous = before.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== description) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path);
  }
  return Object.freeze({ added: Object.freeze(added), changed: Object.freeze(changed), removed: Object.freeze(removed) });
};

export const treesIdentical = (before: TreeSnapshot, after: TreeSnapshot): boolean => {
  const difference = diffTreeSnapshots(before, after);
  return difference.added.length === 0 && difference.changed.length === 0 && difference.removed.length === 0;
};
