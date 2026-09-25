import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { isErrno } from '../core/errors.ts';

const RENAME_ATTEMPTS = 10;

// Windows rejects a replacing rename with EPERM, EACCES, or EBUSY while a
// concurrent writer's rename or a reader briefly holds the target.
const isTransientWin32RenameError = (error: unknown): boolean =>
  process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].some((code) => isErrno(error, code));

const replaceTarget = async (temporary: string, target: string): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (attempt === RENAME_ATTEMPTS || !isTransientWin32RenameError(error)) throw error;
      await sleep(attempt * 10);
    }
  }
};

/**
 * Writes one generated module into the project's `.agent-bundle/test`
 * directory and returns its path. Concurrent Rstest processes regenerate the
 * same modules, so the source lands in a unique sibling that is renamed over
 * the target: a reader loads the previous module or the new one, never a
 * truncated file (#843).
 */
export const writeGeneratedTestModule = async (
  projectRoot: string,
  fileName: string,
  source: string,
): Promise<string> => {
  const directory = resolve(projectRoot, '.agent-bundle', 'test');
  const target = join(directory, fileName);
  const temporary = join(directory, `.${fileName}.${String(process.pid)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    await replaceTarget(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
};
