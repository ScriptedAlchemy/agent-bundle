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
import { claudePluginRowErrors } from '../host-contracts/claude-plugin-validation.ts';
import { stageCursorMarketplace } from './cursor-marketplace.ts';
import {
  compareInstalledTree,
  createInstallReceipt,
  describeContentComparison,
  installReceiptFile,
  installReceiptScopeKey,
  installReceiptStorePath,
  isRemnantReceipt,
  isRuntimeStateRemnant,
  readInstallReceiptFile,
  replaceInstalledTree,
  stageArtifact,
  treeInventory,
  writeInstallReceipt,
  writeStoredInstallReceipt,
  type InstalledManifestIdentity,
  type InstalledTreeComparison,
  type InstallReceiptIdentity,
  type InstallRegistration,
  type TreeInventory,
} from './receipt.ts';

export type InstallHost = 'claude' | 'codex' | 'cursor';
export type InstallScope = 'local' | 'project' | 'user';
/**
 * `adopted`: a byte-identical pre-receipt Cursor copy gained its receipt under
 * `--replace`; no plugin file changed.
 */
export type InstallResultState = 'adopted' | 'already-installed' | 'installed' | 'replaced' | 'staged';

/**
 * Cursor delivery mode: `local` copies into `~/.cursor/plugins/local/<name>`
 * (loads on reload, shown as a local plugin); `marketplace` stages a committed
 * local marketplace repository that Cursor's Customize import registers as a
 * marketplace-installed plugin. See install/cursor-marketplace.ts.
 */
export type InstallMode = 'local' | 'marketplace';

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
  /** Cursor only; defaults to `local`. Other hosts reject an explicit mode. */
  readonly mode?: InstallMode;
  readonly scope?: InstallScope;
}

export interface InstallResult {
  readonly bundleRoot: string;
  /** sha256 over the artifact tree that was installed or found already installed. */
  readonly contentHash?: string;
  /** Git commit of the staged marketplace repository (`mode: 'marketplace'`). */
  readonly commit?: string;
  readonly destination?: string;
  readonly host: InstallHost;
  readonly marketplace?: string;
  readonly mode?: InstallMode;
  /** Remaining host-owned steps the installer cannot perform non-interactively. */
  readonly nextSteps?: readonly string[];
  readonly plugin: string;
  /** Content hash of the copy a `replaced` install superseded. */
  readonly previousContentHash?: string;
  /**
   * The install receipt this run wrote or confirmed: inside the plugin root for Cursor local copies,
   * in the host root's `agent-bundle/receipts` store for host-CLI and marketplace deliveries (#101).
   */
  readonly receipt?: string;
  /**
   * `staged` means the marketplace repository is ready and Cursor's import step is still pending
   * (`mode: 'marketplace'`).
   */
  readonly state: InstallResultState;
  readonly version: string;
}

export interface PluginIdentity {
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

/** The plugin identity an install or uninstall acts on, read from the bundle's host manifests. */
export const readIdentity = async (from: string, host: InstallHost): Promise<PluginIdentity> => {
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

export const defaultCommandRunner: InstallCommandRunner = Object.freeze({
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

export const runHostCommand = async (
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
 * A public host CLI's configuration root (`CLAUDE_CONFIG_DIR` or `~/.claude`;
 * `CODEX_HOME` or `~/.codex`): where the host caches installed plugins and
 * where Agent Bundle keeps its own `agent-bundle/receipts` store for them.
 */
export const publicHostRoot = (
  host: Exclude<InstallHost, 'cursor'>,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string => host === 'claude'
  ? environment['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude')
  : environment['CODEX_HOME'] ?? join(home, '.codex');

/**
 * Where a public host CLI caches an installed marketplace plugin; pinned by
 * the real-host install proofs and shared with the development install sync.
 */
export const publicHostCacheRoot = (
  host: Exclude<InstallHost, 'cursor'>,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string => join(publicHostRoot(host, environment, home), 'plugins', 'cache');

export interface PublicHostInstalledEntry {
  /**
   * The row's `enabled` flag (Claude and Codex both carry one). `false` means
   * the copy is installed but switched off (`claude plugin disable`), so none
   * of it reaches a session until `claude plugin enable` runs; absent when the
   * row carries no boolean.
   */
  readonly enabled?: boolean;
  /**
   * Claude only: the host's own load errors for this copy, verbatim from the
   * row's `errors` array (present and nonempty only when Claude Code refused
   * the plugin, e.g. "Hook load failed: Duplicate hooks file detected ...").
   * A refused copy is installed but contributes no hooks, MCP servers, or
   * skills to a session, so callers must not report it as healthy.
   */
  readonly errors?: readonly string[];
  readonly installPath: string;
  /** Claude only: the scope this copy is installed at. */
  readonly scope?: string;
  readonly version: string;
}

export { claudePluginRowErrors };

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
      const errors = claudePluginRowErrors(row);
      entries.push({
        ...(typeof row['enabled'] === 'boolean' ? { enabled: row['enabled'] } : {}),
        ...(errors.length === 0 ? {} : { errors }),
        installPath: row['installPath'],
        scope: row['scope'],
        version: row['version'],
      });
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
      ...(typeof row['enabled'] === 'boolean' ? { enabled: row['enabled'] } : {}),
      installPath: join(options.cacheRoot, options.marketplace, options.plugin, row['version']),
      version: row['version'],
    }],
    status: 'available',
  };
};

/** Runs the host's inventory verb so replacement only uninstalls what the host reports as installed. */
export const readPublicHostInventory = async (
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

/**
 * A copy the host lists with load errors is installed but refused: Claude Code
 * drops its hooks, MCP servers, and skills from every session. Neither
 * "already installed" nor a fresh install may report it as healthy (`AB7006`).
 */
const refusedInstallFailure = (
  host: Exclude<InstallHost, 'cursor'>,
  id: string,
  entry: PublicHostInstalledEntry,
  phase: 'existing' | 'installed',
): DiagnosticError => failure(
  'AB7006',
  `${host} refused to load ${id} (version ${entry.version}) at ${JSON.stringify(entry.installPath)}` +
    `${entry.scope === undefined ? '' : ` (scope ${entry.scope})`}` +
    `${phase === 'installed' ? ' after installation' : ''}: ${(entry.errors ?? []).join(' | ')} ` +
    `The copy is installed but contributes no hooks, MCP servers, or skills; fix the artifact (\`${host} plugin list --json\` ` +
    'shows the host\'s message under `errors`), rebuild, and rerun `agent-bundle install` with `--replace`.',
  host,
);

/**
 * The host verb that removes an installed plugin. Claude's `--keep-data`
 * always rides along: the installer and `uninstall` manage the plugin's
 * durable data explicitly (`--purge-data`) instead of letting the host decide.
 */
export const publicHostUninstallArguments = (
  host: Exclude<InstallHost, 'cursor'>,
  id: string,
  scope: InstallScope,
): readonly string[] => host === 'claude'
  ? ['plugin', 'uninstall', id, '--scope', scope, '--keep-data']
  : ['plugin', 'remove', id];

/** The host verb that removes a configured marketplace (identical spelling on Claude 2.1.257 and Codex 0.147.0). */
export const publicHostMarketplaceRemoveArguments = (marketplace: string): readonly string[] =>
  ['plugin', 'marketplace', 'remove', marketplace];

/** The registrations `install <host>` performs for a public host CLI, in order. */
export const publicHostRegistrations = (
  host: Exclude<InstallHost, 'cursor'>,
  id: string,
  marketplace: string,
  scope: InstallScope,
): readonly InstallRegistration[] => host === 'claude'
  ? Object.freeze([
    Object.freeze({ kind: 'claude-marketplace' as const, name: marketplace, scope }),
    Object.freeze({ id, kind: 'claude-plugin' as const, scope }),
  ])
  : Object.freeze([
    Object.freeze({ kind: 'codex-marketplace' as const, name: marketplace }),
    Object.freeze({ id, kind: 'codex-plugin' as const }),
  ]);

/**
 * Where the store receipt for a host-CLI install lives:
 * `<host root>/agent-bundle/receipts/<plugin>.<marketplace>.<scope>[.<project digest>].json`.
 * The host identifies a registration as `<plugin>@<marketplace>`, so the same
 * plugin installed from two marketplaces is two installs with two receipts.
 * Claude `project` / `local` registrations belong to the working directory the
 * host verbs ran in (the bundle root), so each project keeps its own receipt.
 */
export const publicHostReceiptPath = (
  host: Exclude<InstallHost, 'cursor'>,
  plugin: string,
  marketplace: string,
  scope: InstallScope,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
  projectRoot?: string,
): string => installReceiptStorePath(
  publicHostRoot(host, environment, home),
  plugin,
  `${marketplace}.${installReceiptScopeKey(scope, projectRoot)}`,
);

/** The project root a Claude `project` / `local` registration belongs to: the cwd the host verbs run in. */
export const publicHostProjectRoot = (
  host: Exclude<InstallHost, 'cursor'>,
  scope: InstallScope,
  identity: PluginIdentity,
): string | undefined => host === 'claude' && scope !== 'user' ? identity.bundleRoot : undefined;

/** `<host> plugin marketplace list --json`: whether a marketplace of this name is configured; `unknown` when unusable. */
export const readPublicHostMarketplaceState = async (
  runner: InstallCommandRunner,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  marketplace: string,
): Promise<'absent' | 'present' | 'unknown'> => {
  let stdout: string;
  try {
    const result = await runner.run(host, ['plugin', 'marketplace', 'list', '--json'], { cwd: identity.bundleRoot });
    if (result.code !== 0) return 'unknown';
    stdout = result.stdout;
  } catch {
    return 'unknown';
  }
  let document: unknown;
  try {
    document = JSON.parse(stdout) as unknown;
  } catch {
    return 'unknown';
  }
  const rows = host === 'claude'
    ? document
    : typeof document === 'object' && document !== null ? (document as { readonly marketplaces?: unknown }).marketplaces : undefined;
  if (!Array.isArray(rows)) return 'unknown';
  return rows.some((row) => typeof row === 'object' && row !== null && (row as { readonly name?: unknown }).name === marketplace)
    ? 'present'
    : 'absent';
};

/** Where the store receipt for a Cursor marketplace-mode install lives. */
export const cursorMarketplaceReceiptPath = (cursorRoot: string, plugin: string): string =>
  installReceiptStorePath(cursorRoot, plugin, 'marketplace');

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
  const projectRoot = publicHostProjectRoot(host, scope, identity);
  const receiptPath = publicHostReceiptPath(host, identity.plugin, marketplace, scope, environment, home, projectRoot);
  const previousReceipt = await readInstallReceiptFile(receiptPath);
  const base = {
    bundleRoot: identity.bundleRoot,
    contentHash: artifact.hash,
    host,
    marketplace,
    plugin: identity.plugin,
    receipt: receiptPath,
    version: identity.version,
  } as const;
  let replaced = false;
  let previousContentHash: string | undefined;
  // Both hosts cache at `<root>/<marketplace>/<plugin>/<version>` (pinned by the real-host proofs), so a
  // reported copy locates where the reinstalled version lands.
  let destination: string | undefined;
  const entry = inventory.status === 'available' ? inventory.entries[0] : undefined;
  // The store receipt is the lifecycle record for this host-owned copy: written on every install and
  // replacement, and refreshed when an identical copy is found without one (pre-#101 installs). It owns
  // no files — the host owns its cache copy — so only the content hash rides along, never an inventory.
  const storeInventory: TreeInventory = Object.freeze({ files: Object.freeze([]), hash: artifact.hash });
  // The marketplace registration is recorded — and therefore reversed by `uninstall` — only when this
  // install (or the receipted install it replaces) created it. A marketplace that was already configured
  // belongs to whoever configured it; when `plugin marketplace list --json` cannot say, the registration
  // is not claimed either (fail-closed: `uninstall` then retains it and says why).
  const receiptIdentity = async (): Promise<InstallReceiptIdentity> => {
    const ownsMarketplace = previousReceipt !== undefined
      ? previousReceipt.registrations.some((registration) => registration.kind === `${host}-marketplace`)
      : await readPublicHostMarketplaceState(runner, identity, host, marketplace) === 'absent';
    return {
      host,
      ...(previousReceipt === undefined ? {} : { installedAt: previousReceipt.installedAt }),
      mode: 'host-cli',
      plugin: identity.plugin,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      registrations: publicHostRegistrations(host, id, marketplace, scope)
        .filter((registration) => ownsMarketplace || registration.kind !== `${host}-marketplace`),
      scope,
      version: identity.version,
    };
  };
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
      // Byte-identical, so reinstalling cannot help: the host's refusal is the artifact's own defect.
      if (entry.errors !== undefined && entry.errors.length > 0) throw refusedInstallFailure(host, id, entry, 'existing');
      if (previousReceipt === undefined || previousReceipt.contentHash !== artifact.hash) {
        await writeStoredInstallReceipt(receiptPath, createInstallReceipt({ ...(await receiptIdentity()), inventory: storeInventory }));
      }
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
      replaced = true;
      // The receipt remembers what the superseded copy hashed when the copy itself cannot be read.
      previousContentHash = installed?.hash ?? previousReceipt?.contentHash;
    }
  }
  // Decided before any host verb runs, so the marketplace ownership check sees the pre-install state.
  const recorded = await receiptIdentity();
  if (replaced) {
    await runHostCommand(runner, identity, host, publicHostUninstallArguments(host, id, scope), 'removal');
  }
  await runHostCommand(runner, identity, host, [
    'plugin',
    'marketplace',
    'add',
    identity.bundleRoot,
  ]);
  // Between `marketplace add` and the receipt write, a marketplace this run created is claimed only in memory.
  // If the plugin install or the receipt write fails there, roll the registration back rather than leave a
  // marketplace nothing records: a retry would then sample it as pre-existing, record only the plugin, and
  // `uninstall` would retain it as user-owned forever.
  const createdMarketplace = previousReceipt === undefined &&
    recorded.registrations.some((registration) => registration.kind === `${host}-marketplace`);
  try {
    await runHostCommand(runner, identity, host, host === 'claude'
      ? ['plugin', 'install', id, '--scope', scope]
      : ['plugin', 'add', id]);
    await writeStoredInstallReceipt(receiptPath, createInstallReceipt({
      ...recorded,
      inventory: storeInventory,
      updatedAt: new Date().toISOString(),
    }));
  } catch (error) {
    if (!createdMarketplace) throw error;
    try {
      await runHostCommand(runner, identity, host, publicHostMarketplaceRemoveArguments(marketplace), 'removal');
    } catch (rollbackError) {
      throw failure(
        'AB7004',
        `${errorMessage(error)} Rolling back the marketplace this install registered also failed: ` +
          `${errorMessage(rollbackError)}. Marketplace ${marketplace} is registered with ${host} but no receipt records it; ` +
          `run \`${host} ${publicHostMarketplaceRemoveArguments(marketplace).join(' ')}\` before retrying.`,
        host,
      );
    }
    throw error;
  }
  // The receipt lands before the load verdict: the host did install the copy, so a refused one stays
  // receipt-owned and `uninstall` removes it without --force.
  if (host === 'claude') {
    // `claude plugin install` exits 0 for a plugin Claude then refuses to load (#464): the load verdict
    // is only in `plugin list --json` `errors`, so verify the fresh row before reporting success. An
    // unusable listing leaves the result unverified rather than failing an install the host accepted.
    const verified = await readPublicHostInventory(runner, identity, host, scope, environment, home);
    if (verified.status === 'available') {
      const refused = verified.entries.find((candidate) =>
        candidate.version === identity.version && candidate.errors !== undefined && candidate.errors.length > 0);
      if (refused !== undefined) throw refusedInstallFailure(host, id, refused, 'installed');
    }
  }
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

/** The loader manifest identity of an installed Cursor copy (`.cursor-plugin/plugin.json`, then root `plugin.json`). */
export const readInstalledManifest = async (destination: string): Promise<InstalledManifestIdentity | undefined> => {
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

/** `~/.cursor`, which must already exist as a directory: installers never create a Cursor home. */
export const resolveCursorRoot = async (options: { readonly home?: string }): Promise<string> => {
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
  return cursorRoot;
};

const installCursorMarketplace = async (
  options: InstallBundleOptions,
  identity: PluginIdentity,
): Promise<InstallResult> => {
  const cursorRoot = await resolveCursorRoot(options);
  try {
    const staged = await stageCursorMarketplace({
      cursorRoot,
      identity,
      runner: options.commandRunner ?? defaultCommandRunner,
      treeHash,
    });
    // The staged repository is a committed Git tree, so its receipt lives in the store beside it; the
    // registration records the commit Cursor imports so uninstall can prove the repository is still ours.
    const receiptPath = cursorMarketplaceReceiptPath(cursorRoot, identity.plugin);
    const previousReceipt = await readInstallReceiptFile(receiptPath);
    const artifact = await treeInventory(identity.bundleRoot);
    if (
      staged.state === 'staged' ||
      previousReceipt === undefined ||
      previousReceipt.contentHash !== artifact.hash ||
      previousReceipt.registrations[0]?.commit !== staged.commit
    ) {
      await writeStoredInstallReceipt(receiptPath, createInstallReceipt({
        host: 'cursor',
        ...(previousReceipt === undefined ? {} : { installedAt: previousReceipt.installedAt }),
        // The committed repository is removed wholesale after a HEAD check; the receipt owns no individual files.
        inventory: { files: [], hash: artifact.hash },
        mode: 'marketplace',
        plugin: identity.plugin,
        registrations: [{
          ...(staged.commit === undefined ? {} : { commit: staged.commit }),
          kind: 'cursor-marketplace-staging',
          name: staged.marketplace,
        }],
        scope: 'user',
        updatedAt: new Date().toISOString(),
        version: identity.version,
      }));
    }
    return {
      bundleRoot: identity.bundleRoot,
      ...(staged.commit === undefined ? {} : { commit: staged.commit }),
      contentHash: artifact.hash,
      destination: staged.destination,
      host: 'cursor',
      marketplace: staged.marketplace,
      mode: 'marketplace',
      nextSteps: staged.nextSteps,
      plugin: identity.plugin,
      receipt: receiptPath,
      state: staged.state,
      version: identity.version,
    };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw failure('AB7004', errorMessage(error), 'cursor');
  }
};

const installCursor = async (
  options: InstallBundleOptions,
  identity: PluginIdentity,
  scope: InstallScope,
): Promise<InstallResult> => {
  if (scope !== 'user') {
    throw failure('AB7003', `Cursor plugin installation supports only user scope, not ${scope}.`, 'cursor');
  }
  if (options.mode === 'marketplace') return installCursorMarketplace(options, identity);
  const cursorRoot = await resolveCursorRoot(options);
  const installRoot = join(cursorRoot, 'plugins', 'local');
  const destination = join(installRoot, identity.plugin);
  const base = {
    bundleRoot: identity.bundleRoot,
    destination,
    host: 'cursor',
    mode: 'local',
    plugin: identity.plugin,
    receipt: join(destination, installReceiptFile),
    version: identity.version,
  } as const;
  try {
    const artifact = await treeInventory(identity.bundleRoot);
    // The receipt records which host directories this installer created on the way to the plugin root
    // (a fresh Cursor home has no `plugins/local`), so uninstall can prune exactly those and no more.
    const hostDirectories: string[] = [];
    for (const relativePath of ['plugins', 'plugins/local']) {
      if (!await exists(join(cursorRoot, relativePath))) hostDirectories.push(relativePath);
    }
    await mkdir(installRoot, { recursive: true });
    const receipt: InstallReceiptIdentity = {
      host: 'cursor',
      hostDirectories,
      mode: 'local',
      plugin: identity.plugin,
      registrations: [{ kind: 'cursor-local-plugin' }],
      scope: 'user',
      version: identity.version,
    };
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
    const compared = await compareInstalledTree({
      artifact,
      destination,
      installedManifest: await readInstalledManifest(destination),
      plugin: identity.plugin,
      version: identity.version,
    });
    // `uninstall --keep-data` leaves a shell holding only state/ (plus, normally, a remnant receipt that owns no
    // files): a reinstall fills it back in around the preserved durable state instead of refusing it as foreign
    // (nothing in it is anyone's plugin content) and reports an install, not a replacement.
    const remnant = compared.ownership === 'receipt' && compared.receipt !== undefined
      ? isRemnantReceipt(compared.receipt)
      : compared.ownership === 'foreign' && await isRuntimeStateRemnant(destination);
    const comparison: InstalledTreeComparison = remnant && compared.ownership === 'foreign'
      ? { ...compared, ownership: 'legacy', status: 'stale' }
      : compared;
    if (comparison.status === 'current') {
      if (comparison.ownership === 'legacy' && options.replace === true) {
        // Adoption created nothing: the legacy copy's directories are not the installer's to prune.
        await writeInstallReceipt(destination, createInstallReceipt({
          ...receipt,
          directories: [],
          hostDirectories: [],
          inventory: artifact,
        }));
        return { ...base, contentHash: artifact.hash, state: 'adopted' };
      }
      // A receipt-managed identical copy whose receipt predates format/2 is upgraded in place: the
      // lifecycle fields are synthesized exactly as the reader migrates them, and nothing else changes.
      if (comparison.ownership === 'receipt' && comparison.receipt?.migratedFrom !== undefined) {
        await writeInstallReceipt(destination, createInstallReceipt({
          ...receipt,
          directories: comparison.receipt.directories,
          hostDirectories: comparison.receipt.hostDirectories,
          installedAt: comparison.receipt.installedAt,
          inventory: artifact,
          updatedAt: new Date().toISOString(),
        }));
      }
      return { ...base, contentHash: artifact.hash, state: 'already-installed' };
    }
    const replaceable = (comparison.status === 'stale' && comparison.ownership === 'receipt') || remnant
      ? true
      : comparison.status !== 'foreign' && options.replace === true;
    if (!replaceable) {
      throw failure('AB7005', collisionMessage(destination, identity, comparison), 'cursor');
    }
    // Replacing an existing copy created no host directories; the previous receipt's carry over.
    const replacement: InstallReceiptIdentity = { ...receipt, hostDirectories: comparison.receipt?.hostDirectories ?? [] };
    const staged = await stageArtifact({ artifactRoot: identity.bundleRoot, destination, receipt: replacement, stageRoot: installRoot });
    try {
      await replaceInstalledTree({ comparison, destination, receipt: replacement, staged });
    } finally {
      await rm(staged.parent, { force: true, recursive: true });
    }
    // Filling a state-only shell is a fresh install of plugin content, not a replacement of any.
    if (remnant) return { ...base, contentHash: artifact.hash, state: 'installed' };
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
  if (options.mode !== undefined && options.host !== 'cursor') {
    return yield* Effect.fail(failure(
      'AB7003',
      `Install mode ${JSON.stringify(options.mode)} applies to the cursor host only.`,
      options.host,
    ));
  }
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
