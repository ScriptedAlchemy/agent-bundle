import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A byte-level picture of a directory tree: every entry (files by sha256 and
 * mode bits, directories, symlink targets), sorted and POSIX-relative to the
 * root.
 *
 * @typedef {ReadonlyMap<string, string>} TreeSnapshot
 */

/**
 * @param {string} root
 * @returns {Promise<TreeSnapshot>}
 */
export const snapshotTree = async (root) => {
  const entries = new Map();
  const visit = async (relativePath) => {
    let names;
    try {
      names = (await readdir(join(root, relativePath))).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
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

/**
 * @typedef {object} TreeSnapshotDifference
 * @property {readonly string[]} added
 * @property {readonly string[]} changed
 * @property {readonly string[]} removed
 */

/**
 * @param {TreeSnapshot} before
 * @param {TreeSnapshot} after
 * @returns {TreeSnapshotDifference}
 */
export const diffTreeSnapshots = (before, after) => {
  const added = [];
  const changed = [];
  const removed = [];
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

/**
 * @param {TreeSnapshot} before
 * @param {TreeSnapshot} after
 */
export const treesIdentical = (before, after) => {
  const difference = diffTreeSnapshots(before, after);
  return difference.added.length === 0 && difference.changed.length === 0 && difference.removed.length === 0;
};

/** @param {string} root */
export const digestTree = async (root) => {
  const snapshot = await snapshotTree(root);
  return createHash('sha256').update(JSON.stringify([...snapshot])).digest('hex');
};
