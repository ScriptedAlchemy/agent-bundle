import { rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Replaces a watched source atomically through a rename staged OUTSIDE the
 * watched project. An in-place write is truncate-then-append: the dev
 * compiler can start a compile off the truncation event, read incomplete
 * content, and then drop the append event because both operations land
 * within the same mtime tick, so the final content never compiles and the
 * expected revision never activates. The temp file lives in the project's
 * parent (same filesystem, never watched) so the rename into place is the
 * only event the watcher observes.
 */
export const replaceWatchedSource = async (projectRoot: string, path: string, content: string): Promise<void> => {
  const temporary = join(projectRoot, '..', `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
};
