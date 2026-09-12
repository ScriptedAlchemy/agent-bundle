import { existsSync, realpathSync } from 'node:fs';
import { delimiter as defaultDelimiter, dirname, join } from 'node:path';

const npmCliJs = 'npm-cli.js';

/** Filesystem and environment the resolver consults. Tests inject a fake. */
export interface NpmCliResolutionIo {
  readonly delimiter?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly exists: (candidate: string) => boolean;
  readonly realpath: (candidate: string) => string;
}

const isNpmCliJs = (candidate: string): boolean => candidate.endsWith(npmCliJs);

/** Official Node layouts relative to a `bin/` or install-prefix directory. */
const officialNpmCliCandidates = (directory: string): readonly string[] => [
  join(directory, 'node_modules', 'npm', 'bin', npmCliJs),
  join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', npmCliJs),
  join(directory, '..', 'node_modules', 'npm', 'bin', npmCliJs),
];

const realpathIfNpmCli = (io: NpmCliResolutionIo, candidate: string): string | undefined => {
  if (!io.exists(candidate)) return undefined;
  try {
    const real = io.realpath(candidate);
    return isNpmCliJs(real) ? real : undefined;
  } catch {
    return undefined;
  }
};

const candidatesFromDirectory = (io: NpmCliResolutionIo, directory: string): readonly string[] => {
  const found: string[] = [...officialNpmCliCandidates(directory)];
  // Unix nvm: `bin/npm` → `../lib/node_modules/npm/bin/npm-cli.js`.
  // Windows: `npm.cmd` / `npm.ps1` do not realpath to npm-cli.js; the
  // official layouts above still find the JS entry beside the shim.
  for (const shim of ['npm', 'npm.cmd', 'npm.ps1', 'npm.exe'] as const) {
    const resolved = realpathIfNpmCli(io, join(directory, shim));
    if (resolved !== undefined) found.push(resolved);
  }
  return found;
};

/**
 * Locates a real on-disk `npm-cli.js`. Never assumes `npm` is a resolvable
 * package from `createRequire(import.meta.url)` — a pnpm-managed Node has no
 * such dependency from this module — and never treats `npm_execpath` as npm
 * when it points at pnpm or a cmd shim.
 */
export const resolveNpmCliJs = (io: NpmCliResolutionIo): string => {
  const execDir = dirname(io.execPath);
  const delimiter = io.delimiter ?? defaultDelimiter;
  const pathEnv = io.env['PATH'] ?? io.env['Path'] ?? io.env['path'] ?? '';
  const prefix = io.env['npm_config_prefix'] ?? io.env['NPM_CONFIG_PREFIX'];
  const candidates: (string | undefined)[] = [];

  const execpath = io.env['npm_execpath'];
  if (execpath !== undefined && isNpmCliJs(execpath)) candidates.push(execpath);

  candidates.push(...candidatesFromDirectory(io, execDir));
  if (prefix !== undefined && prefix.length > 0) {
    candidates.push(...officialNpmCliCandidates(prefix));
    candidates.push(...candidatesFromDirectory(io, join(prefix, 'bin')));
  }
  for (const entry of pathEnv.split(delimiter)) {
    if (entry.length === 0) continue;
    candidates.push(...candidatesFromDirectory(io, entry));
  }

  for (const candidate of candidates) {
    if (candidate !== undefined && isNpmCliJs(candidate) && io.exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve npm-cli.js from ${io.execPath}`);
};

/** Resolves `npm-cli.js` from the running Node and process environment. */
export const resolveProcessNpmCliJs = (): string =>
  resolveNpmCliJs({
    env: process.env,
    execPath: process.execPath,
    exists: existsSync,
    realpath: realpathSync,
  });
