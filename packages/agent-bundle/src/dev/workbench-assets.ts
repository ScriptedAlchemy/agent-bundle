import { basename, extname, resolve } from 'node:path';

import { Effect, FileSystem, Option } from 'effect';

import { isInside } from '../core/paths.ts';
import { isPlatformErrno, readFileBytes } from '../effect/platform.ts';
import { platformRunOf } from './platform-run.ts';
import type { DevPlatformRuntime } from './platform-runtime.ts';

import type { WorkbenchAssetSource } from './foreground-server.ts';

export interface WorkbenchAssetSourceOptions {
  /** Root of the prebuilt workbench asset tree. */
  readonly root?: string;
  /** The dev server's session runtime; absent, each program runs on its own `platformLayer`. */
  readonly platformRuntime?: DevPlatformRuntime;
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

// The Workbench build copies its attribution files into the asset tree without
// an extension (`THIRD_PARTY_NOTICES`, `src/mcp/APP-RENDERER-LICENSE`). Those
// conventional names are plain text a browser should render; every other
// extensionless file keeps the binary fallback.
const noticeFileName = /^(?:[a-z0-9]+[-_])*(?:licen[cs]e|notices?|copying)$/iu;

const contentTypeFor = (path: string): string => {
  const extension = extname(path).toLowerCase();
  if (extension === '') return noticeFileName.test(basename(path)) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  return contentTypes[extension] ?? 'application/octet-stream';
};

const contentHashedAsset = /(?:^|\/)[^/]+\.[a-f0-9]{8}(?:\.[^./]+)+$/iu;

export const workbenchDocumentCacheControl = 'no-store';
export const workbenchHashedAssetCacheControl = 'public, max-age=31536000, immutable';

export const workbenchAssetCacheControl = (servedPath: string): string =>
  contentHashedAsset.test(servedPath) ? workbenchHashedAssetCacheControl : workbenchDocumentCacheControl;

/**
 * Reads only regular files from the fixed prebuilt workbench tree. The HTTP
 * server already rejects malformed request paths; this source makes direct
 * callers and future routes obey the same containment boundary.
 */
export const createWorkbenchAssetSource = (
  options: WorkbenchAssetSourceOptions = {},
): WorkbenchAssetSource => {
  const root = resolve(options.root ?? defaultRoot());
  const run = platformRunOf(options.platformRuntime);
  // Resolved once, like the former eager `realpath(root)` promise: a missing
  // root surfaces on the first read, as it did.
  let resolvedRoot: Promise<string> | undefined;
  const resolveRoot = (): Promise<string> => {
    resolvedRoot ??= run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(root)));
    return resolvedRoot;
  };
  // The tree is fixed once built, so successful reads are cached forever.
  // Misses are never cached: they carry no read cost worth saving, and a
  // hostile stream of request paths must not grow the cache.
  const served = new Map<string, Readonly<{ body: Buffer; contentType: string }>>();
  return Object.freeze({
    read: async (path: string) => {
      if (!path || path.includes('\0')) return undefined;
      const candidate = resolve(root, path);
      if (!isInside(root, candidate)) return undefined;
      const cached = served.get(candidate);
      if (cached !== undefined) return cached;
      const actualRoot = await resolveRoot().catch((error: unknown) => {
        if (isPlatformErrno(error, 'ENOENT')) return undefined;
        throw error;
      });
      if (actualRoot === undefined) return undefined;
      const asset = await run(readContainedAsset(actualRoot, candidate));
      if (Option.isNone(asset)) return undefined;
      served.set(candidate, asset.value);
      return asset.value;
    },
  });
};

/** `realPath` → containment → regular-file `stat` → bytes; `ENOENT` anywhere is a miss, other errors propagate. */
const readContainedAsset = Effect.fnUntraced(function* (actualRoot: string, candidate: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const actualPath = yield* fs.realPath(candidate);
    if (!isInside(actualRoot, actualPath)) return Option.none<Readonly<{ body: Buffer; contentType: string }>>();
    const metadata = yield* fs.stat(actualPath);
    if (metadata.type !== 'File') return Option.none<Readonly<{ body: Buffer; contentType: string }>>();
    const body = yield* readFileBytes(actualPath);
    return Option.some(Object.freeze({ body, contentType: contentTypeFor(actualPath) }));
  }).pipe(Effect.catch((error) => isPlatformErrno(error, 'ENOENT')
    ? Effect.succeed(Option.none<Readonly<{ body: Buffer; contentType: string }>>())
    : Effect.fail(error)));
});
