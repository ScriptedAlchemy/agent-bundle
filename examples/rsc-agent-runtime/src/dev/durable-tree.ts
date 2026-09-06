import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Containment and durability rules shared by environment checkpoint staging
 * and generation capture: regular files and directories only, no symbolic
 * links, no unsafe path segments, and every written file and directory
 * fsynced before its tree is trusted.
 */

export const digestBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const isSafeSegment = (value: string): boolean =>
  value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');

export const assertInside = (root: string, target: string): void => {
  const path = relative(resolve(root), resolve(target));
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${JSON.stringify(target)} escaped its root ${JSON.stringify(root)}.`);
  }
};

export const fsyncPath = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Creates `destination` (refusing to overwrite), writes `bytes`, and fsyncs it. */
export const writeFileDurably = async (destination: string, bytes: Uint8Array): Promise<void> => {
  const handle = await open(destination, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * Walks `sourceRoot` in sorted order, recreating its directories under the
 * new `destinationRoot` and calling `onFile(path, source, destination)` for
 * every regular file, where `path` is slash-separated and relative to the
 * roots. Each directory is fsynced after its entries land.
 */
export const copyTree = async (
  sourceRoot: string,
  destinationRoot: string,
  onFile: (path: string, source: string, destination: string) => Promise<void>,
): Promise<void> => {
  const sourceStatus = await lstat(sourceRoot);
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error(`${JSON.stringify(sourceRoot)} must be a regular directory.`);
  }
  await mkdir(destinationRoot, { recursive: false });

  const copyDirectory = async (source: string, destination: string, prefix: string): Promise<void> => {
    assertInside(sourceRoot, source);
    assertInside(destinationRoot, destination);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!isSafeSegment(entry.name)) throw new Error('Compiler output contains an unsafe path segment.');
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      assertInside(sourceRoot, sourcePath);
      assertInside(destinationRoot, destinationPath);
      const status = await lstat(sourcePath);
      if (status.isSymbolicLink()) throw new Error('Compiler output cannot contain symbolic links.');
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (status.isDirectory()) {
        await mkdir(destinationPath, { recursive: false });
        await copyDirectory(sourcePath, destinationPath, path);
      } else if (status.isFile()) {
        await onFile(path, sourcePath, destinationPath);
      } else {
        throw new Error('Compiler output can contain only regular files and directories.');
      }
    }
    await fsyncPath(destination);
  };

  await copyDirectory(sourceRoot, destinationRoot, '');
};
