import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { meetsMinimumVersion, parseSemanticVersion } from '../core/semver.ts';
import { copyOpaqueCodexAuthState, digestFileTree, withoutProviderApiKeys } from '../host-contracts/native-codex-contract.ts';
import { withoutEvalCredentialEnvironment } from './credentials.ts';
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

/** Digests only the state a run could plausibly disturb: auth, config, and installed plugins. */
export const digestCodexHome = async (codexHome: string): Promise<CodexHomeDigest> => {
  const [auth, config, plugins] = await Promise.all([
    digestFileTree(join(codexHome, 'auth.json'), { hashContents: true, includeIdentity: true }),
    digestFileTree(join(codexHome, 'config.toml'), { hashContents: true, includeIdentity: true }),
    digestFileTree(join(codexHome, 'plugins'), { hashContents: false, includeIdentity: true }),
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
  ...withoutProviderApiKeys(withoutEvalCredentialEnvironment(environment)),
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

export const codexVersionCompatible = (raw: string): boolean => {
  const observed = parseSemanticVersion(raw);
  const minimum = parseSemanticVersion(minimumCodexEvalVersion);
  if (observed === undefined || minimum === undefined) return false;
  return meetsMinimumVersion(observed, minimum);
};

export const codexUnauthenticatedOutput = (output: string): boolean =>
  /(?:\bauth(?:entication)?\b|\blog[ -]?in\b|\bsign[ -]?in\b|\bsubscription\b|\bunauthorized\b|\b401\b)/iu.test(output);
