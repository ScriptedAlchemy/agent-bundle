import { basename, dirname, resolve } from 'node:path';

/**
 * The package root owning one compiler-provided runtime module. Provenance
 * records consumer-authored sources, not framework runtime modules and their
 * shared chunks.
 */
export const runtimeIgnoredRoot = (path: string): string => {
  const normalized = path.replaceAll('\\', '/');
  let directory = dirname(normalized);
  while (true) {
    if (basename(directory) === 'dist' || basename(directory) === 'src') {
      return resolve(dirname(directory));
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Runtime module is not under an owning package src or dist directory: ${JSON.stringify(path)}.`);
    }
    directory = parent;
  }
};
