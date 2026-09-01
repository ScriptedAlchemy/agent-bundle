import { rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Replaces a file the dev server may read concurrently (watcher events or an
 * in-flight prepare) with one atomic rename, so no reader ever observes a
 * truncated or partially written source. A plain writeFile truncates first:
 * a watcher can read the empty window, or coalesce the truncate and append
 * events within one mtime tick and drop the content. The temp file lives in
 * the project's parent (same filesystem, never watched) so the rename into
 * place is the only event a watcher observes.
 */
export const replaceWatchedSource = async (projectRoot: string, path: string, content: string): Promise<void> => {
  const temporary = join(projectRoot, '..', `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
};
