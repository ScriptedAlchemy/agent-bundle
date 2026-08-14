import { realpath, stat, readFile } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';

import type { WorkbenchAssetSource } from './foreground-server.ts';

export interface WorkbenchAssetSourceOptions {
  /** Root of the prebuilt workbench asset tree. */
  readonly root?: string;
}

const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

// Rslib bundles this helper into dist/api.js, while source-level consumers run
// it from src/dev. Resolve the package root from either supported layout.
const packageRoot = basename(import.meta.dirname) === 'dist'
  ? resolve(import.meta.dirname, '..')
  : resolve(import.meta.dirname, '../..');

const defaultRoot = (): string => resolve(packageRoot, 'dist', 'workbench');

const contained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !path.includes(`..${sep}`);
};

const contentTypeFor = (path: string): string => contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';

/**
 * Reads only regular files from the fixed prebuilt workbench tree. The HTTP
 * server already rejects malformed request paths; this source makes direct
 * callers and future routes obey the same containment boundary.
 */
export const createWorkbenchAssetSource = (
  options: WorkbenchAssetSourceOptions = {},
): WorkbenchAssetSource => {
  const root = resolve(options.root ?? defaultRoot());
  const resolvedRoot = realpath(root);
  return Object.freeze({
    read: async (path: string) => {
      if (!path || path.includes('\0')) return undefined;
      const candidate = resolve(root, path);
      if (!contained(root, candidate)) return undefined;
      try {
        const [actualRoot, actualPath] = await Promise.all([resolvedRoot, realpath(candidate)]);
        if (!contained(actualRoot, actualPath)) return undefined;
        const metadata = await stat(actualPath);
        if (!metadata.isFile()) return undefined;
        return Object.freeze({ body: await readFile(actualPath), contentType: contentTypeFor(actualPath) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
  });
};
