import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { copyOpaqueCodexAuthState, withoutProviderApiKeys } from '../host-contracts/native-codex-contract.ts';
import { CodexEvalHarnessError } from './codex-errors.ts';

/** Mirrors the W1 Codex contract minimum; older CLIs are rejected instead of adapted to. */
export const minimumCodexEvalVersion = '0.147.0';

export interface CodexHomeDigest {
  readonly auth: string;
  readonly config: string;
  readonly plugins: string;
}

export interface TemporaryCodexTrialHome {
  readonly candidate: string;
  readonly home: string;
  readonly root: string;
  readonly workspace: string;
}

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

/**
 * Hashes file contents for the small credential and configuration files, and file identity
 * (size, mode, mtime) for the installed-plugin tree, which is far too large to read twice a trial.
 */
const digestTree = async (path: string, contents: boolean): Promise<string> => {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  const hash = createHash('sha256');
  if (entry.isFile()) {
    hash.update(`file\0${entry.mode}\0${entry.size}\0`);
    if (contents) hash.update(await readFile(path));
    else hash.update(`${entry.mtimeMs}\0`);
    return hash.digest('hex');
  }
  if (entry.isDirectory()) {
    hash.update('directory\0');
    const children = await readdir(path, { withFileTypes: true });
    for (const child of [...children].sort((left, right) => left.name.localeCompare(right.name))) {
      hash.update(`${child.name}\0${await digestTree(join(path, child.name), contents)}\0`);
    }
    return hash.digest('hex');
  }
  hash.update(`other\0${entry.mode}\0`);
  return hash.digest('hex');
};

/** Digests only the state a run could plausibly disturb: auth, config, and installed plugins. */
export const digestCodexHome = async (codexHome: string): Promise<CodexHomeDigest> => {
  const [auth, config, plugins] = await Promise.all([
    digestTree(join(codexHome, 'auth.json'), true),
    digestTree(join(codexHome, 'config.toml'), true),
    digestTree(join(codexHome, 'plugins'), false),
  ]);
  return Object.freeze({ auth, config, plugins });
};

export const codexHomeUnchanged = (before: CodexHomeDigest, after: CodexHomeDigest): boolean =>
  before.auth === after.auth && before.config === after.config && before.plugins === after.plugins;

export const resolveNormalCodexHome = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string => environment.CODEX_HOME ?? join(homedir(), '.codex');

/**
 * The child inherits the ordinary environment with every model-provider API key removed, so the
 * installed CLI can only proceed on its existing signed-in session.
 */
export const codexChildEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  temporaryHome: string,
): NodeJS.ProcessEnv => Object.freeze({
  ...withoutProviderApiKeys(environment),
  CODEX_HOME: temporaryHome,
});

export const createTemporaryCodexTrialHome = async (parent: string): Promise<TemporaryCodexTrialHome> => {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'agent-bundle-codex-trial-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  return Object.freeze({
    candidate: join(root, 'candidate'),
    home,
    root,
    workspace: join(root, 'workspace'),
  });
};

export const removeTemporaryCodexTrialHome = async (root: string): Promise<void> => {
  await rm(root, { force: true, recursive: true });
};

/**
 * Copies `auth.json` byte for byte with its original mode. The file is never read as data,
 * parsed, logged, or rewritten; the harness only moves the bytes into the temporary home.
 */
export const adoptCodexAuthState = async (
  normalCodexHome: string,
  temporaryHome: string,
): Promise<void> => {
  try {
    await copyOpaqueCodexAuthState(join(normalCodexHome, 'auth.json'), join(temporaryHome, 'auth.json'));
  } catch (error) {
    throw new CodexEvalHarnessError(
      'CODEX_CLI_UNAUTHENTICATED',
      `The installed Codex CLI has no signed-in session to reuse at ${JSON.stringify(join(normalCodexHome, 'auth.json'))}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const parseSemanticVersion = (value: string): SemanticVersion | undefined => {
  const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:$|[^0-9])/u.exec(value);
  if (match === null) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  });
};

export const codexVersionCompatible = (raw: string): boolean => {
  const observed = parseSemanticVersion(raw);
  const minimum = parseSemanticVersion(minimumCodexEvalVersion);
  if (observed === undefined || minimum === undefined) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (observed[key] !== minimum[key]) return observed[key] > minimum[key];
  }
  return !observed.prerelease;
};

export const codexUnauthenticatedOutput = (output: string): boolean =>
  /(?:\bauth(?:entication)?\b|\blog[ -]?in\b|\bsign[ -]?in\b|\bsubscription\b|\bunauthorized\b|\b401\b)/iu.test(output);
