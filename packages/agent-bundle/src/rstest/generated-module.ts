import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
};
