import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Effect, Predicate } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { errorMessage, isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { runPromise } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';
import {
  compareInstalledTree,
  createInstallReceipt,
  describeContentComparison,
  replaceInstalledTree,
  stageArtifact,
  treeInventory,
  writeInstallReceipt,
  type InstalledManifestIdentity,
  type InstalledTreeComparison,
  type TreeInventory,
} from './receipt.ts';

export type InstallHost = 'claude' | 'codex' | 'cursor';
export type InstallScope = 'local' | 'project' | 'user';
/**
 * `adopted`: a byte-identical pre-receipt Cursor copy gained its receipt under
 * `--replace`; no plugin file changed.
 */
export type InstallResultState = 'adopted' | 'already-installed' | 'installed' | 'replaced';

export interface InstallCommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface InstallCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<InstallCommandResult>;
}

export interface InstallBundleOptions {
  readonly commandRunner?: InstallCommandRunner;
  /** Process environment consulted for host cache roots (`CODEX_HOME`); defaults to `process.env`. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly from: string;
  readonly home?: string;
  readonly host: InstallHost;
  /**
   * Replace an existing agent-bundle install of this plugin even when its
   * version differs (`--replace` / `--force`). Same-version content drift is
   * replaced automatically; foreign directories are always refused.
   */
  readonly replace?: boolean;
  readonly scope?: InstallScope;
}

export interface InstallResult {
  readonly bundleRoot: string;
  /** sha256 over the artifact tree that was installed or found already installed. */
  readonly contentHash?: string;
  readonly destination?: string;
  readonly host: InstallHost;
  readonly marketplace?: string;
  readonly plugin: string;
  /** Content hash of the copy a `replaced` install superseded. */
  readonly previousContentHash?: string;
  readonly state: InstallResultState;
  readonly version: string;
}

interface PluginIdentity {
  readonly bundleRoot: string;
  readonly marketplace?: string;
  readonly plugin: string;
  readonly version: string;
}

const failure = (
  code: string,
  message: string,
  target: InstallHost,
): DiagnosticError => new DiagnosticError([{
  code,
  message,
  severity: 'error',
  target,
}]);

const hostManifestPath = (host: InstallHost): string => {
  switch (host) {
    case 'claude':
      return '.claude-plugin/plugin.json';
    case 'codex':
      return '.codex-plugin/plugin.json';
    case 'cursor':
      return '.cursor-plugin/plugin.json';
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown install host ${String(exhaustive)}.`);
    }
  }
};

const marketplacePath = (host: Exclude<InstallHost, 'cursor'>): string =>
  host === 'claude'
    ? '.claude-plugin/marketplace.json'
    : '.agents/plugins/marketplace.json';

const readRecord = async (
  path: string,
  host: InstallHost,
  kind: string,
): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw failure('AB7001', `Cannot read a valid ${kind} at ${JSON.stringify(path)}.`, host);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('AB7001', `${kind} at ${JSON.stringify(path)} must be a JSON object.`, host);
  }
  return value as Record<string, unknown>;
};

const readString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  host: InstallHost,
  kind: string,
): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw failure('AB7001', `${kind} must declare a nonempty ${key}.`, host);
  }
  return value;
};

const resolveBundleRoot = async (from: string, host: InstallHost): Promise<string> => {
  const root = resolve(from);
  const manifest = hostManifestPath(host);
  if (await exists(join(root, manifest))) return root;
  const targetRoot = join(root, host);
  if (await exists(join(targetRoot, manifest))) return targetRoot;
  const pluginRoot = join(root, 'plugin');
  if (await exists(join(pluginRoot, manifest))) return pluginRoot;
  throw failure(
    'AB7001',
    `No ${host} bundle manifest was found in ${JSON.stringify(root)}, its ${JSON.stringify(host)} target directory, or its "plugin" target directory.`,
    host,
  );
};

const readIdentity = async (from: string, host: InstallHost): Promise<PluginIdentity> => {
  const bundleRoot = await resolveBundleRoot(from, host);
  const pluginDocument = await readRecord(join(bundleRoot, hostManifestPath(host)), host, `${host} plugin manifest`);
  const plugin = readString(pluginDocument, 'name', host, `${host} plugin manifest`);
  const version = readString(pluginDocument, 'version', host, `${host} plugin manifest`);
  if (
    host === 'cursor' &&
    (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(plugin) || plugin.length > 64)
  ) {
    throw failure('AB7001', `Cursor plugin name ${JSON.stringify(plugin)} is not a safe local plugin name.`, host);
  }
  if (host === 'cursor') return { bundleRoot, plugin, version };
  const marketplaceDocument = await readRecord(
    join(bundleRoot, marketplacePath(host)),
    host,
    `${host} marketplace`,
  );
  return {
    bundleRoot,
    marketplace: readString(marketplaceDocument, 'name', host, `${host} marketplace`),
    plugin,
    version,
  };
};

const defaultCommandRunner: InstallCommandRunner = Object.freeze({
  run: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<InstallCommandResult> => new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { cwd: options.cwd }, (error, stdout, stderr) => {
      if (error !== null && isErrno(error, 'ENOENT')) {
        reject(error);
        return;
      }
      resolvePromise({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stderr,
        stdout,
      });
    });
  }),
});

const runHostCommand = async (
  runner: InstallCommandRunner,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  args: readonly string[],
  operation: 'installation' | 'removal' = 'installation',
): Promise<InstallCommandResult> => {
  let result: InstallCommandResult;
  try {
    result = await runner.run(host, args, { cwd: identity.bundleRoot });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw failure('AB7002', `${host} is not installed or is not available on PATH.`, host);
    }
    throw error;
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw failure('AB7004', `${host} plugin ${operation} failed: ${detail}`, host);
  }
  return result;
};

/**
 * Where a public host CLI caches an installed marketplace plugin; pinned by
 * the real-host install proofs and shared with the development install sync.
 */
export const publicHostCacheRoot = (
  host: Exclude<InstallHost, 'cursor'>,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string => host === 'claude'
  ? join(environment['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'), 'plugins', 'cache')
  : join(environment['CODEX_HOME'] ?? join(home, '.codex'), 'plugins', 'cache');

export interface PublicHostInstalledEntry {
  readonly installPath: string;
  /** Claude only: the scope this copy is installed at. */
  readonly scope?: string;
  readonly version: string;
}

/**
 * The host's own answer to "is this plugin installed, and where": usable, or
 * not, never guessed. Claude can hold one copy per scope, so an unscoped read
 * returns every matching copy; a scoped read returns at most one.
 */
export type PublicHostInventory =
  | { readonly entries: readonly PublicHostInstalledEntry[]; readonly status: 'available' }
  | { readonly detail: string; readonly status: 'unavailable' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses `<host> plugin list --json` for one plugin. Claude rows carry the
 * cache path (`installPath`) and scope; Codex rows confirm installation and
 * version only, so the pinned cache layout supplies the path. Shared by
 * `install` (before replacing) and `doctor` (when comparing), so both read the
 * host's inventory identically.
 */
export const parsePublicHostInventory = (
  host: Exclude<InstallHost, 'cursor'>,
  stdout: string,
  options: {
    readonly cacheRoot: string;
    readonly marketplace: string;
    readonly plugin: string;
    /** Claude only: restrict to rows installed at this scope. */
    readonly scope?: InstallScope;
  },
): PublicHostInventory => {
  const id = `${options.plugin}@${options.marketplace}`;
  let document: unknown;
  try {
    document = JSON.parse(stdout) as unknown;
  } catch {
    return { detail: `${host} plugin list --json did not return JSON`, status: 'unavailable' };
  }
  if (host === 'claude') {
    if (!Array.isArray(document)) {
      return { detail: 'claude plugin list --json did not return an array', status: 'unavailable' };
    }
    const rows = document.filter((candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate['id'] === id);
    const entries: PublicHostInstalledEntry[] = [];
    for (const row of rows) {
      // Every row for this plugin must be readable before the scope filter runs: a matching row we
      // cannot read is not "not installed", and replacing on it would skip the uninstall.
      if (
        typeof row['installPath'] !== 'string' ||
        typeof row['scope'] !== 'string' ||
        typeof row['version'] !== 'string'
      ) {
        return {
          detail: `claude plugin list --json row for ${id} carries no installPath, scope, or version`,
          status: 'unavailable',
        };
      }
      if (options.scope !== undefined && row['scope'] !== options.scope) continue;
      entries.push({ installPath: row['installPath'], scope: row['scope'], version: row['version'] });
    }
    return { entries, status: 'available' };
  }
  if (!isRecord(document) || !Array.isArray(document['installed'])) {
    return { detail: 'codex plugin list --json did not return an installed array', status: 'unavailable' };
  }
  const row = document['installed'].find((candidate) =>
    isRecord(candidate) && candidate['pluginId'] === id && candidate['installed'] !== false);
  if (row === undefined) return { entries: [], status: 'available' };
  if (!isRecord(row) || typeof row['version'] !== 'string') {
    return { detail: `codex plugin list --json row for ${id} carries no version`, status: 'unavailable' };
  }
  return {
    entries: [{
      installPath: join(options.cacheRoot, options.marketplace, options.plugin, row['version']),
      version: row['version'],
    }],
    status: 'available',
  };
};

/** Runs the host's inventory verb so replacement only uninstalls what the host reports as installed. */
const readPublicHostInventory = async (
  runner: InstallCommandRunner,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  scope: InstallScope,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<PublicHostInventory> => {
  let result: InstallCommandResult;
  try {
    result = await runner.run(host, ['plugin', 'list', '--json'], { cwd: identity.bundleRoot });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw failure('AB7002', `${host} is not installed or is not available on PATH.`, host);
    }
    return { detail: errorMessage(error), status: 'unavailable' };
  }
  if (result.code !== 0) {
    return { detail: result.stderr.trim() || `exit code ${result.code}`, status: 'unavailable' };
  }
  return parsePublicHostInventory(host, result.stdout, {
    cacheRoot: publicHostCacheRoot(host, environment, home),
    marketplace: identity.marketplace ?? '',
    plugin: identity.plugin,
    scope,
  });
};

const publicHostUninstallArguments = (
  host: Exclude<InstallHost, 'cursor'>,
  id: string,
  scope: InstallScope,
): readonly string[] => host === 'claude'
  ? ['plugin', 'uninstall', id, '--scope', scope, '--keep-data']
  : ['plugin', 'remove', id];

const installPublicCli = async (
  options: InstallBundleOptions,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  scope: InstallScope,
): Promise<InstallResult> => {
  if (host === 'codex' && scope !== 'user') {
    throw failure('AB7003', `Codex plugin installation supports only user scope, not ${scope}.`, host);
  }
  const marketplace = identity.marketplace;
  if (marketplace === undefined) {
    throw failure('AB7001', `${host} bundle has no marketplace identity.`, host);
  }
  const runner = options.commandRunner ?? defaultCommandRunner;
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const id = `${identity.plugin}@${marketplace}`;
  const artifact = await treeInventory(identity.bundleRoot);
  const inventory = await readPublicHostInventory(runner, identity, host, scope, environment, home);
  if (inventory.status === 'unavailable' && options.replace === true) {
    throw failure(
      'AB7004',
      `Cannot replace the ${host} install of ${id} safely: ${host} plugin list --json was unusable (${inventory.detail}).`,
      host,
    );
  }
  const base = {
    bundleRoot: identity.bundleRoot,
    contentHash: artifact.hash,
    host,
    marketplace,
    plugin: identity.plugin,
    version: identity.version,
  } as const;
  let replaced = false;
  let previousContentHash: string | undefined;
  // Both hosts cache at `<root>/<marketplace>/<plugin>/<version>` (pinned by the real-host proofs), so a
  // reported copy locates where the reinstalled version lands.
  let destination: string | undefined;
  const entry = inventory.status === 'available' ? inventory.entries[0] : undefined;
  if (entry !== undefined) {
    destination = join(dirname(entry.installPath), identity.version);
    let installed: TreeInventory | undefined;
    try {
      installed = await treeInventory(entry.installPath);
    } catch (error) {
      // The host says a copy is installed but it cannot be compared: never let that pass as "no drift".
      if (options.replace !== true) {
        throw failure(
          'AB7004',
          `${host} installed copy of ${id} at ${JSON.stringify(entry.installPath)} could not be compared: ` +
            `${errorMessage(error)}. Re-run with --replace to reinstall it.`,
          host,
        );
      }
      installed = undefined;
    }
    const sameVersion = entry.version === identity.version;
    if (installed !== undefined && sameVersion && installed.hash === artifact.hash) {
      return { ...base, destination: entry.installPath, state: 'already-installed' };
    }
    if (!sameVersion && options.replace !== true) {
      const detail = describeContentComparison(identity.plugin, identity.version, {
        artifactContentHash: artifact.hash,
        installedContentHash: installed?.hash ?? 'unknown',
        installedName: identity.plugin,
        installedVersion: entry.version,
        status: 'version-mismatch',
      });
      throw failure(
        'AB7005',
        `Refusing version collision for ${host} ${id} at ${entry.installPath}: ${detail}. ` +
          'Re-run with --replace to replace the installed version.',
        host,
      );
    }
    const contentDrift = installed !== undefined && sameVersion && installed.hash !== artifact.hash;
    if (options.replace === true || contentDrift) {
      await runHostCommand(runner, identity, host, publicHostUninstallArguments(host, id, scope), 'removal');
      replaced = true;
      previousContentHash = installed?.hash;
    }
  }
  await runHostCommand(runner, identity, host, [
    'plugin',
    'marketplace',
    'add',
    identity.bundleRoot,
  ]);
  await runHostCommand(runner, identity, host, host === 'claude'
    ? ['plugin', 'install', id, '--scope', scope]
    : ['plugin', 'add', id]);
  return {
    ...base,
    ...(destination === undefined ? {} : { destination }),
    ...(previousContentHash === undefined ? {} : { previousContentHash }),
    state: replaced ? 'replaced' : 'installed',
  };
};

/** sha256 over a plugin tree in installer order; the install receipt is never part of it. */
export const treeHash = async (root: string): Promise<string> => (await treeInventory(root)).hash;

const cursorManifestCandidates = Object.freeze(['.cursor-plugin/plugin.json', 'plugin.json']);

const readInstalledManifest = async (destination: string): Promise<InstalledManifestIdentity | undefined> => {
  for (const manifest of cursorManifestCandidates) {
    try {
      const document = JSON.parse(await readFile(join(destination, manifest), 'utf8')) as unknown;
      if (Predicate.isObject(document) && typeof document.name === 'string') {
        return {
          name: document.name,
          ...(typeof document.version === 'string' ? { version: document.version } : {}),
        };
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
};

const collisionMessage = (
  destination: string,
  identity: PluginIdentity,
  comparison: InstalledTreeComparison,
): string => {
  const detail = describeContentComparison(identity.plugin, identity.version, comparison);
  switch (comparison.status) {
    case 'foreign':
      return `Refusing foreign install at ${destination}: ${detail}; the directory is not an agent-bundle install of ` +
        `${identity.plugin}, so --replace does not apply. Remove it manually if it is stale.`;
    case 'version-mismatch':
      return `Refusing version collision at ${destination}: ${detail}. Re-run with --replace to replace this agent-bundle install.`;
    case 'stale':
      return `Refusing content collision at ${destination}: ${detail}; this copy predates install receipts. ` +
        'Re-run with --replace once to adopt it; later same-version rebuilds replace automatically.';
    case 'current':
      return `Install at ${destination} is current.`;
    default: {
      const exhaustive: never = comparison.status;
      throw new TypeError(`Unknown install comparison ${String(exhaustive)}.`);
    }
  }
};

const installCursor = async (
  options: InstallBundleOptions,
  identity: PluginIdentity,
  scope: InstallScope,
): Promise<InstallResult> => {
  if (scope !== 'user') {
    throw failure('AB7003', `Cursor local plugin installation supports only user scope, not ${scope}.`, 'cursor');
  }
  const cursorRoot = join(options.home ?? homedir(), '.cursor');
  let cursorMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    cursorMetadata = await lstat(cursorRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw failure('AB7002', `Cursor is not installed in ${JSON.stringify(cursorRoot)}.`, 'cursor');
    }
    throw error;
  }
  if (!cursorMetadata.isDirectory()) {
    throw failure('AB7002', `Cursor home ${JSON.stringify(cursorRoot)} is not a directory.`, 'cursor');
  }
  const installRoot = join(cursorRoot, 'plugins', 'local');
  const destination = join(installRoot, identity.plugin);
  const base = {
    bundleRoot: identity.bundleRoot,
    destination,
    host: 'cursor',
    plugin: identity.plugin,
    version: identity.version,
  } as const;
  try {
    const artifact = await treeInventory(identity.bundleRoot);
    await mkdir(installRoot, { recursive: true });
    const receipt = { host: 'cursor', plugin: identity.plugin, version: identity.version } as const;
    if (!await exists(destination)) {
      const staged = await stageArtifact({ artifactRoot: identity.bundleRoot, destination, receipt, stageRoot: installRoot });
      try {
        await rename(staged.root, destination);
      } finally {
        await rm(staged.parent, { force: true, recursive: true });
      }
      return { ...base, contentHash: artifact.hash, state: 'installed' };
    }
    if (resolve(identity.bundleRoot) === destination) {
      return { ...base, contentHash: artifact.hash, state: 'already-installed' };
    }
    const comparison = await compareInstalledTree({
      artifact,
      destination,
      installedManifest: await readInstalledManifest(destination),
      plugin: identity.plugin,
      version: identity.version,
    });
    if (comparison.status === 'current') {
      if (comparison.ownership === 'legacy' && options.replace === true) {
        // Adoption created nothing: the legacy copy's directories are not the installer's to prune.
        await writeInstallReceipt(destination, createInstallReceipt({
          directories: [],
          host: 'cursor',
          inventory: artifact,
          plugin: identity.plugin,
          version: identity.version,
        }));
        return { ...base, contentHash: artifact.hash, state: 'adopted' };
      }
      return { ...base, contentHash: artifact.hash, state: 'already-installed' };
    }
    const replaceable = comparison.status === 'stale' && comparison.ownership === 'receipt'
      ? true
      : comparison.status !== 'foreign' && options.replace === true;
    if (!replaceable) {
      throw failure('AB7005', collisionMessage(destination, identity, comparison), 'cursor');
    }
    const staged = await stageArtifact({ artifactRoot: identity.bundleRoot, destination, receipt, stageRoot: installRoot });
    try {
      await replaceInstalledTree({ comparison, destination, receipt, staged });
    } finally {
      await rm(staged.parent, { force: true, recursive: true });
    }
    return {
      ...base,
      contentHash: artifact.hash,
      previousContentHash: comparison.installedContentHash,
      state: 'replaced',
    };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw failure(
      'AB7004',
      errorMessage(error),
      'cursor',
    );
  }
};

const installProgram = Effect.fnUntraced(function*(
  options: InstallBundleOptions,
): Effect.fn.Return<InstallResult, unknown> {
  const scope = options.scope ?? 'user';
  const identity = yield* liftPromise(() => readIdentity(options.from, options.host));
  switch (options.host) {
    case 'claude':
      return yield* liftPromise(() => installPublicCli(options, identity, 'claude', scope));
    case 'codex':
      return yield* liftPromise(() => installPublicCli(options, identity, 'codex', scope));
    case 'cursor':
      return yield* liftPromise(() => installCursor(options, identity, scope));
    default: {
      const exhaustive: never = options.host;
      return yield* Effect.fail(failure('AB7000', `Unsupported install host ${String(exhaustive)}.`, options.host));
    }
  }
});

export const installBundle = (
  options: InstallBundleOptions,
): Promise<InstallResult> => runPromise(installProgram(options));
