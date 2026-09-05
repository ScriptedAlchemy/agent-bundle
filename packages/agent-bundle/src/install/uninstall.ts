import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { errorMessage, isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { runPromise } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';
import { cacheHasPlugin, readHeadCommit } from './cursor-hooks-registration.ts';
import { cursorMarketplaceName, cursorMarketplacePluginPath, cursorMarketplaceRoot } from './cursor-marketplace.ts';
import {
  cursorMarketplaceReceiptPath,
  defaultCommandRunner,
  publicHostMarketplaceRemoveArguments,
  publicHostProjectRoot,
  publicHostReceiptPath,
  publicHostRegistrations,
  publicHostRoot,
  publicHostUninstallArguments,
  readInstalledManifest,
  readPublicHostInventory,
  readPublicHostMarketplaceState,
  runHostCommand,
  type InstallCommandResult,
  type InstallCommandRunner,
  type InstallHost,
  type InstallMode,
  type InstallScope,
  type PublicHostInstalledEntry,
} from './install.ts';
import { installedBundleInventory, readBundleIdentity, type PluginIdentity } from './identity.ts';
import {
  assertRealAncestors,
  createInstallReceipt,
  directoriesOf,
  emptyContentHash,
  hasInstallSurfaceMarkers,
  hashOwnedFiles,
  installReceiptFile,
  installReceiptFormat,
  installReceiptStoreDirectory,
  isPreservedRuntimeRoot,
  isRemnantReceipt,
  listStoredInstallReceipts,
  pruneEmptyDirectory,
  readInstallReceipt,
  readInstallReceiptFile,
  removeStoredInstallReceipt,
  shortHash,
  simulateRemoveStoredInstallReceipt,
  treeInventory,
  writeInstallReceipt,
  writeStoredInstallReceipt,
  type InstallReceipt,
  type InstallReceiptMode,
  type InstallRegistration,
  type StoredInstallReceipt,
} from './receipt.ts';
import { installedWebDataRoot, type InstalledStateRoot, resolveInstalledStateRoot } from './state-root.ts';

/**
 * `agent-bundle uninstall <host>` (#101): the receipt-owned reverse of
 * `install`. Every mutation is opt-in, fail-closed, and bounded by what the
 * install receipt records — owned files and directories, the host
 * registrations the installer performed, and the host directories it created.
 * Nothing outside that set is ever removed; durable runtime state (`state/`,
 * the state kernel and notices journal) is kept unless `--purge-data` is
 * confirmed explicitly. `--plan` computes the same result without opening a
 * writer, and a second run after a successful uninstall is a `not-installed`
 * no-op.
 */

export type UninstallDataPolicy = 'keep' | 'purge';

/**
 * What happened to the plugin's durable runtime state. `kept`/`purged`/`absent`
 * are Agent Bundle's own doing; `retained-by-host` (Claude keeps the orphaned
 * cache copy, `state/` included, for its ~14-day grace period) and
 * `removed-by-host` (Codex deletes the cached tree, `state/` included, on
 * `plugin remove`) name the host behaviour that decided instead; `unavailable`
 * means the delivery holds no runtime state (a staged marketplace repository).
 */
export type UninstallDataOutcome =
  | 'absent'
  | 'kept'
  | 'purged'
  | 'removed-by-host'
  | 'retained-by-host'
  | 'unavailable';

export interface UninstallDataReport {
  readonly detail: string;
  readonly outcome: UninstallDataOutcome;
  /** The durable-state paths the decision applied to (absolute). */
  readonly paths: readonly string[];
  readonly policy: UninstallDataPolicy;
}

/**
 * `removed`: reversed by this run; `already-absent`: the host no longer held it
 * (idempotent rerun, or the host pruned it); `retained`: deliberately left in
 * place (another installed plugin still uses the marketplace); `manual`: the
 * host exposes no non-interactive verb, `nextSteps` names the UI step;
 * `planned`: `--plan` would remove it.
 */
export type UninstallRegistrationAction = 'already-absent' | 'manual' | 'planned' | 'removed' | 'retained';

export interface UninstallRegistrationReport extends InstallRegistration {
  readonly action: UninstallRegistrationAction;
  readonly detail?: string;
}

/**
 * How the receipt drove this run: `consumed` (read, honoured, removed),
 * `migrated` (a format/1 receipt read with synthesized lifecycle fields),
 * `forced-missing`/`forced-legacy`/`forced-mismatch` (`--force` overrode a
 * missing receipt, a pre-receipt legacy copy, or an owned-content hash
 * mismatch), `missing` (nothing installed; no receipt to consume), `remnant`
 * (a remnant receipt from an earlier `--keep-data` uninstall was found and
 * left in place because only preserved state remains and it is being kept).
 */
export type UninstallReceiptStatus =
  | 'consumed'
  | 'forced-legacy'
  | 'forced-mismatch'
  | 'forced-missing'
  | 'migrated'
  | 'missing'
  | 'remnant';

export interface UninstallReceiptReport {
  readonly contentHash?: string;
  readonly format?: string;
  readonly installedAt?: string;
  readonly migratedFrom?: string;
  readonly path: string;
  readonly status: UninstallReceiptStatus;
  readonly version?: string;
}

export type UninstallResultState = 'not-installed' | 'planned' | 'uninstalled';

export interface UninstallResult {
  readonly bundleRoot: string;
  readonly data: UninstallDataReport;
  /** The installed plugin root the run acted on (cache copy, local directory, or staged repository). */
  readonly destination?: string;
  readonly forced: boolean;
  readonly host: InstallHost;
  readonly marketplace?: string;
  readonly mode: InstallReceiptMode;
  /** Host-owned steps the uninstaller cannot perform non-interactively. */
  readonly nextSteps?: readonly string[];
  readonly plugin: string;
  readonly receipt: UninstallReceiptReport;
  readonly registrations: readonly UninstallRegistrationReport[];
  /**
   * Cursor local only: the plugin root survived (retained runtime state or unowned entries), so a remnant
   * receipt owning no files was written there to keep the created host directories receipt-owned.
   */
  readonly remnantReceipt?: string;
  /** Exact absolute paths removed (or, under `--plan`, that would be removed; directories only when empty). */
  readonly removed: {
    readonly directories: readonly string[];
    readonly files: readonly string[];
  };
  /** Unowned entries left in place under the destination (relative to it); surviving unowned directories end in `/`. */
  readonly retained: readonly string[];
  readonly scope: InstallScope;
  readonly state: UninstallResultState;
  readonly version: string;
}

export interface UninstallBundleOptions {
  readonly commandRunner?: InstallCommandRunner;
  /** Required with `purgeData`: the explicit confirmation that durable state may be deleted. */
  readonly confirmPurge?: boolean;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /**
   * Proceed without a receipt (a pre-receipt legacy copy, or a host-registered
   * copy with no store receipt) or when owned content no longer matches the
   * receipt. Foreign directories — a receipt or manifest naming another plugin
   * — are refused regardless.
   */
  readonly force?: boolean;
  readonly from: string;
  readonly home?: string;
  readonly host: InstallHost;
  /** Explicitly keep durable runtime state (the default). */
  readonly keepData?: boolean;
  /** Cursor only; defaults to `local`. */
  readonly mode?: InstallMode;
  /** Compute and report the exact plan without changing anything. */
  readonly plan?: boolean;
  /** Remove durable runtime state too; refused without `confirmPurge`. */
  readonly purgeData?: boolean;
  readonly scope?: InstallScope;
}

const failure = (code: string, message: string, target: InstallHost): DiagnosticError =>
  new DiagnosticError([{ code, message, severity: 'error', target }]);

const unsupportedEntry = (path: string, host: InstallHost): DiagnosticError => failure(
  'AB7007',
  `Refusing unsupported filesystem entry at ${JSON.stringify(path)}: uninstall acts on regular files and real directories only.`,
  host,
);

const resolveDataPolicy = (options: UninstallBundleOptions): UninstallDataPolicy => {
  if (options.purgeData === true && options.keepData === true) {
    throw failure('AB7008', '`--keep-data` and `--purge-data` are mutually exclusive.', options.host);
  }
  if (options.purgeData === true && options.confirmPurge !== true) {
    throw failure(
      'AB7008',
      '`--purge-data` deletes the plugin\'s durable runtime state (state kernel, notices journal) and requires ' +
        '`--confirm-purge`; omit both flags to keep the data.',
      options.host,
    );
  }
  return options.purgeData === true ? 'purge' : 'keep';
};

const realDirectory = async (path: string, host: InstallHost): Promise<Stats | undefined> => {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsupportedEntry(path, host);
  return metadata;
};

const receiptReport = (path: string, receipt: InstallReceipt | undefined, status: UninstallReceiptStatus): UninstallReceiptReport =>
  Object.freeze({
    ...(receipt === undefined ? {} : {
      contentHash: receipt.contentHash,
      format: receipt.migratedFrom ?? installReceiptFormat,
      installedAt: receipt.installedAt,
      ...(receipt.migratedFrom === undefined ? {} : { migratedFrom: receipt.migratedFrom }),
      version: receipt.version,
    }),
    path,
    status,
  });

const deepestFirst = (directories: readonly string[]): readonly string[] =>
  [...directories].sort((left, right) => right.length - left.length || left.localeCompare(right));

/** Removes empty directories deepest first; reports the ones actually removed. */
const pruneDirectories = async (paths: readonly string[]): Promise<readonly string[]> => {
  const removed: string[] = [];
  for (const path of deepestFirst(paths)) {
    if (await pruneEmptyDirectory(path)) removed.push(path);
  }
  return removed;
};

/**
 * What `pruneDirectories` would remove once `removedPaths` (files and whole
 * directories) are gone: deepest first, a candidate is pruned when every entry
 * it still holds is itself removed or pruned. `--plan` reports exactly this set,
 * so a directory kept alive by retained state or unowned entries is never listed.
 */
const simulatePrune = async (paths: readonly string[], removedPaths: ReadonlySet<string>): Promise<readonly string[]> => {
  const gone = new Set(removedPaths);
  const pruned: string[] = [];
  for (const path of deepestFirst(paths)) {
    if (await wouldPrune(path, gone)) pruned.push(path);
  }
  return pruned;
};

/** Whether `pruneEmptyDirectory(path)` would succeed once every path in `gone` is removed; records it in `gone` when so. */
const wouldPrune = async (path: string, gone: Set<string>): Promise<boolean> => {
  let entries: readonly string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
  if (!entries.every((entry) => gone.has(join(path, entry)))) return false;
  gone.add(path);
  return true;
};

/**
 * Unowned entries under `root` that survive the uninstall, POSIX-relative: regular files (and symlinks, listed
 * but never followed) that are not owned and not runtime state, plus unowned directories holding nothing
 * retained (`name/`), which the prune never touches because only owned directories are candidates. A directory
 * that holds a retained entry is implied by that entry and is not listed itself.
 */
const listRetained = async (
  root: string,
  owned: ReadonlySet<string>,
  ownedDirectories: ReadonlySet<string>,
): Promise<readonly string[]> => {
  const retained: string[] = [];
  const visit = async (relativePath: string): Promise<number> => {
    let entries: readonly string[];
    try {
      entries = (await readdir(join(root, relativePath))).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return 0;
      throw error;
    }
    let kept = 0;
    for (const name of entries) {
      const child = relativePath === '' ? name : `${relativePath}/${name}`;
      if (relativePath === '' && (name === installReceiptFile || isPreservedRuntimeRoot(name))) continue;
      const metadata = await lstat(join(root, child));
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        const below = await visit(child);
        if (below === 0 && !ownedDirectories.has(child)) retained.push(`${child}/`);
        kept += below === 0 && !ownedDirectories.has(child) ? 1 : below;
        continue;
      }
      if (!owned.has(child)) {
        retained.push(child);
        kept += 1;
      }
    }
    return kept;
  };
  await visit('');
  return Object.freeze(retained);
};

interface CursorLocalOwnership {
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly hostDirectories: readonly string[];
  readonly receipt: InstallReceipt | undefined;
  readonly status: UninstallReceiptStatus;
}

/**
 * Decides what a Cursor local uninstall may remove. A receipt naming this
 * plugin owns exactly its files and directories; its owned content must hash
 * to the recorded content hash unless `--force`. Without a receipt, only a
 * legacy layout (emitted install surface plus a manifest naming this plugin)
 * may be removed, and only under `--force`, by its inventory. Anything else is
 * foreign and is refused with or without `--force`.
 */
const cursorLocalOwnership = async (
  destination: string,
  identity: PluginIdentity,
  force: boolean,
): Promise<CursorLocalOwnership> => {
  const receipt = await readInstallReceipt(destination);
  if (receipt === undefined) {
    const manifest = await readInstalledManifest(destination);
    const legacy = manifest?.name === identity.plugin && await hasInstallSurfaceMarkers(destination);
    if (!legacy) {
      throw failure(
        'AB7007',
        `Refusing to uninstall foreign directory ${destination}: it carries no install receipt and is not a ` +
          `recognizable agent-bundle install of ${identity.plugin}` +
          `${manifest === undefined ? ' (no loader manifest)' : ` (manifest names ${JSON.stringify(manifest.name)})`}. ` +
          'Remove it manually if it is stale; --force does not apply to foreign directories.',
        'cursor',
      );
    }
    if (!force) {
      throw failure(
        'AB7009',
        `Refusing to uninstall ${destination} without an install receipt: this copy predates install receipts, so ` +
          'ownership cannot be proven. Re-run with --force to remove its inventoried plugin files (runtime state ' +
          'under state/ is kept unless --purge-data --confirm-purge is passed), or reinstall with --replace first to adopt it.',
        'cursor',
      );
    }
    const inventory = await treeInventory(destination);
    return {
      directories: directoriesOf(inventory.files),
      files: inventory.files,
      hostDirectories: [],
      receipt: undefined,
      status: 'forced-legacy',
    };
  }
  if (receipt.plugin !== identity.plugin) {
    throw failure(
      'AB7007',
      `Refusing to uninstall ${destination}: its install receipt names plugin ${JSON.stringify(receipt.plugin)}, ` +
        `not ${JSON.stringify(identity.plugin)}. Uninstall that plugin from its own bundle instead; --force does not apply.`,
      'cursor',
    );
  }
  const installedContentHash = await hashOwnedFiles(destination, receipt.files);
  let status: UninstallReceiptStatus = receipt.migratedFrom === undefined ? 'consumed' : 'migrated';
  if (installedContentHash !== receipt.contentHash) {
    if (!force) {
      throw failure(
        'AB7007',
        `Refusing to uninstall ${destination}: the owned files hash ${shortHash(installedContentHash)} but the ` +
          `receipt recorded ${shortHash(receipt.contentHash)}, so the installed copy was modified after installation. ` +
          'Re-run with --force to remove the receipt-owned files anyway (unowned entries are never removed).',
        'cursor',
      );
    }
    status = 'forced-mismatch';
  }
  return {
    directories: receipt.directories,
    files: receipt.files,
    hostDirectories: receipt.hostDirectories,
    receipt,
    status,
  };
};

/** The `PLUGIN_DATA` directory the emitted installer creates for an Agent Plugins pack copied into Cursor (spec §9.1). */
export const cursorPluginDataDirectory = (cursorRoot: string, plugin: string): string =>
  join(cursorRoot, 'agent-bundle', 'plugin-data', plugin);

/**
 * Whether this home's `PLUGIN_DATA` directory exists as a real directory reached only through real directories:
 * a symlinked `agent-bundle` or `plugin-data` ancestor would let a recursive purge of the leaf follow it outside
 * the Cursor home, so any link on the way is refused (AB7007) before anything is read or removed.
 */
const realPluginDataDirectory = async (cursorRoot: string, pluginData: string): Promise<boolean> => {
  for (const directory of [join(cursorRoot, 'agent-bundle'), join(cursorRoot, 'agent-bundle', 'plugin-data'), pluginData]) {
    if (await realDirectory(directory, 'cursor') === undefined) return false;
  }
  return true;
};

interface CursorLocalData {
  /** Installer-created `PLUGIN_DATA` directory that nothing wrote to: pruned like a created host directory, never "data". */
  readonly emptyPluginData?: string;
  /** A `state/` directory holding nothing: not durable state, so it is pruned rather than kept alive as a remnant. */
  readonly emptyState?: string;
  /** Whether any durable state root exists. */
  readonly present: boolean;
  readonly report: UninstallDataReport;
  readonly stateRoot: InstalledStateRoot;
  readonly webDataRoot: string;
}

const cursorLocalData = async (
  destination: string,
  policy: UninstallDataPolicy,
  receipt: InstallReceipt | undefined,
  cursorRoot: string,
  plugin: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<CursorLocalData> => {
  const stateDirectory = join(destination, 'state');
  const effectiveState = receipt?.stateRoot ??
    await resolveInstalledStateRoot(destination, 'cursor', environment, home);
  const webData = receipt?.webDataRoot ?? installedWebDataRoot(destination, home);
  const paths: string[] = [];
  const kinds: string[] = [];
  let emptyState: string | undefined;
  if (
    effectiveState.root !== stateDirectory &&
    await realDirectory(effectiveState.root, 'cursor') !== undefined
  ) {
    paths.push(effectiveState.root);
    kinds.push(`${effectiveState.source} framework state root ${effectiveState.root}`);
  }
  if (await realDirectory(stateDirectory, 'cursor') !== undefined) {
    if ((await readdir(stateDirectory)).length === 0) {
      emptyState = stateDirectory;
    } else {
      paths.push(stateDirectory);
      kinds.push('state/ (state kernel, notices journal)');
    }
  }
  if (await realDirectory(webData, 'cursor') !== undefined) {
    paths.push(webData);
    kinds.push(`web-data directory ${webData}`);
  }
  // The receipt's cursorExpansion records the PLUGIN_DATA directory the installer created for this copy; only the
  // directory at this home's own plugin-data location is receipt-owned — a recorded path elsewhere is left alone.
  const recorded = receipt?.cursorExpansion?.pluginData;
  const expected = cursorPluginDataDirectory(cursorRoot, plugin);
  let emptyPluginData: string | undefined;
  let foreignPluginData: string | undefined;
  if (recorded !== undefined) {
    if (recorded !== expected) {
      foreignPluginData = recorded;
    } else if (await realPluginDataDirectory(cursorRoot, recorded)) {
      if ((await readdir(recorded)).length === 0) {
        emptyPluginData = recorded;
      } else {
        paths.push(recorded);
        kinds.push(`the PLUGIN_DATA directory ${recorded}`);
      }
    }
  }
  const foreignNote = foreignPluginData === undefined
    ? ''
    : ` The receipt records PLUGIN_DATA at ${foreignPluginData}, outside this home's agent-bundle/plugin-data; it is not touched.`;
  if (paths.length === 0) {
    return {
      ...(emptyPluginData === undefined ? {} : { emptyPluginData }),
      ...(emptyState === undefined ? {} : { emptyState }),
      present: false,
      report: Object.freeze({
        detail: `No durable runtime state exists (${
          emptyState === undefined ? 'no state/ under the installed plugin root' : 'state/ under the installed plugin root is empty and is pruned'
        }${
          emptyPluginData === undefined ? '' : `; the installer-created PLUGIN_DATA directory ${emptyPluginData} is empty and is pruned`
        }).${foreignNote}`,
        outcome: 'absent',
        paths: Object.freeze([]),
        policy,
      }),
      stateRoot: effectiveState,
      webDataRoot: webData,
    };
  }
  return {
    ...(emptyPluginData === undefined ? {} : { emptyPluginData }),
    ...(emptyState === undefined ? {} : { emptyState }),
    present: true,
    report: Object.freeze({
      detail: policy === 'purge'
        ? `Durable runtime state — ${kinds.join(' and ')} — is removed (--purge-data --confirm-purge).${foreignNote}`
        : `Durable runtime state — ${kinds.join(' and ')} — is kept; pass --purge-data --confirm-purge to remove it.${foreignNote}`,
      outcome: policy === 'purge' ? 'purged' : 'kept',
      paths: Object.freeze(paths),
      policy,
    }),
    stateRoot: effectiveState,
    webDataRoot: webData,
  };
};

const uninstallCursorLocal = async (
  options: UninstallBundleOptions,
  identity: PluginIdentity,
  policy: UninstallDataPolicy,
): Promise<UninstallResult> => {
  const force = options.force === true;
  const base = {
    bundleRoot: identity.bundleRoot,
    forced: force,
    host: 'cursor',
    mode: 'local',
    plugin: identity.plugin,
    scope: 'user',
    version: identity.version,
  } as const;
  const cursorRoot = join(options.home ?? homedir(), '.cursor');
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const destination = join(cursorRoot, 'plugins', 'local', identity.plugin);
  const receiptPath = join(destination, installReceiptFile);
  const notInstalled = (): UninstallResult => Object.freeze({
    ...base,
    data: Object.freeze({
      detail: 'Nothing is installed, so no durable runtime state exists.',
      outcome: 'absent',
      paths: Object.freeze([]),
      policy,
    }),
    destination,
    receipt: receiptReport(receiptPath, undefined, 'missing'),
    registrations: Object.freeze([Object.freeze({ action: 'already-absent' as const, kind: 'cursor-local-plugin' as const })]),
    removed: Object.freeze({ directories: Object.freeze([]), files: Object.freeze([]) }),
    retained: Object.freeze([]),
    state: 'not-installed',
  });
  if (await realDirectory(cursorRoot, 'cursor') === undefined) return notInstalled();
  if (await realDirectory(destination, 'cursor') === undefined) return notInstalled();
  const ownership = await cursorLocalOwnership(destination, identity, force);
  const owned = new Set(ownership.files);
  // A symlinked ancestor would let a leaf-only delete reach outside the plugin root: refused before any change.
  await assertRealAncestors(destination, ownership.files);
  const data = await cursorLocalData(
    destination,
    policy,
    ownership.receipt,
    cursorRoot,
    identity.plugin,
    environment,
    home,
  );
  const files: string[] = [];
  for (const file of ownership.files) {
    const path = join(destination, file);
    let metadata: Stats;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw unsupportedEntry(path, 'cursor');
    files.push(path);
  }
  if (ownership.receipt !== undefined || await exists(receiptPath)) files.push(receiptPath);
  // External state kept by --keep-data needs the remnant receipt and canonical install path so a later purge can
  // derive and remove the same root even though no plugin content remains.
  const keepRoot = policy === 'keep' &&
    data.report.paths.some((path) => path !== join(destination, 'state'));
  const pluginDataRecorded = ownership.receipt?.cursorExpansion?.pluginData === cursorPluginDataDirectory(cursorRoot, identity.plugin);
  const directoryCandidates = [
    ...ownership.directories.map((directory) => join(destination, directory)),
    ...(keepRoot ? [] : [destination]),
    ...ownership.hostDirectories.map((directory) => join(cursorRoot, directory)),
    // The installer created PLUGIN_DATA and its agent-bundle parents; once empty they go too — never while
    // receipts, marketplaces, or another plugin's data keep them alive.
    ...(data.emptyPluginData === undefined ? [] : [data.emptyPluginData]),
    ...(data.emptyState === undefined ? [] : [data.emptyState]),
    ...(pluginDataRecorded ? [join(cursorRoot, 'agent-bundle', 'plugin-data'), join(cursorRoot, 'agent-bundle')] : []),
  ];
  const ownedDirectories = new Set(ownership.directories);
  const retained = await listRetained(destination, owned, ownedDirectories);
  const remnantOnly = ownership.receipt !== undefined && isRemnantReceipt(ownership.receipt);
  const purging = data.present && policy === 'purge';
  if (remnantOnly && policy !== 'purge' && (data.present || retained.length > 0) && files.length === 1 && files[0] === receiptPath) {
    // A rerun over what an earlier `--keep-data` uninstall left behind, still keeping data that is still there
    // (or unowned entries that keep the root alive): nothing to remove, so the remnant receipt stays in place and
    // the run is the documented no-op. Once the preserved state is gone — state/ or the PLUGIN_DATA directory
    // removed or emptied by hand — the remnant guards nothing, and the rerun below consumes it (receipt, empty
    // plugin root, the host and plugin-data directories it recorded) like an explicit purge would.
    return Object.freeze({
      ...base,
      data: data.report,
      destination,
      receipt: receiptReport(receiptPath, ownership.receipt, 'remnant'),
      registrations: Object.freeze([Object.freeze({
        action: 'already-absent' as const,
        detail: 'Only preserved runtime state remained from an earlier `uninstall --keep-data`; no plugin content was registered.',
        kind: 'cursor-local-plugin' as const,
      })]),
      remnantReceipt: receiptPath,
      removed: Object.freeze({ directories: Object.freeze([]), files: Object.freeze([]) }),
      retained,
      state: 'not-installed',
    });
  }
  const registrations: readonly UninstallRegistrationReport[] = Object.freeze([Object.freeze({
    action: remnantOnly ? 'already-absent' as const : options.plan === true ? 'planned' as const : 'removed' as const,
    detail: remnantOnly
      ? 'Only preserved runtime state remained from an earlier `uninstall --keep-data`; no plugin content was registered.'
      : 'Cursor loads plugins/local/<name> directly; removing the directory unregisters the plugin at the next window reload.',
    kind: 'cursor-local-plugin' as const,
  })]);
  const purgedDirectories = purging ? data.report.paths : [];
  if (options.plan === true) {
    const directories = await simulatePrune(directoryCandidates, new Set([...files, ...purgedDirectories]));
    // The plugin root survives (retained state, unowned entries, or kept PLUGIN_DATA) exactly when the simulation
    // cannot prune it.
    const survives = !directories.includes(destination);
    return Object.freeze({
      ...base,
      data: data.report,
      destination,
      receipt: receiptReport(receiptPath, ownership.receipt, ownership.status),
      registrations,
      ...(survives ? { remnantReceipt: receiptPath } : {}),
      removed: Object.freeze({
        directories: Object.freeze([...purgedDirectories, ...directories]),
        files: Object.freeze(files),
      }),
      retained,
      state: 'planned',
    });
  }
  for (const path of files) await rm(path, { force: true });
  for (const path of purgedDirectories) await rm(path, { force: true, recursive: true });
  const directories = await pruneDirectories(directoryCandidates);
  const retainedAfter = await exists(destination) ? await listRetained(destination, owned, ownedDirectories) : Object.freeze([]);
  let remnantReceipt: string | undefined;
  if (await exists(destination)) {
    // The plugin root survives (retained runtime state or unowned entries), so a remnant receipt keeps the
    // lifecycle receipt-owned: it owns no files and records no registrations, but carries the host
    // directories this install created so a later purge can still prune them, and lets Doctor explain the
    // directory instead of calling it corrupt. A reinstall fills it back in as an `installed`.
    await writeInstallReceipt(destination, createInstallReceipt({
      // A kept PLUGIN_DATA directory stays receipt-owned through the remnant's expansion record.
      ...(ownership.receipt?.cursorExpansion === undefined ||
        !data.report.paths.includes(ownership.receipt.cursorExpansion.pluginData)
        ? {}
        : { cursorExpansion: ownership.receipt.cursorExpansion }),
      host: 'cursor',
      hostDirectories: ownership.hostDirectories,
      ...(ownership.receipt === undefined ? {} : { installedAt: ownership.receipt.installedAt }),
      inventory: { files: [], hash: emptyContentHash },
      mode: 'local',
      plugin: identity.plugin,
      registrations: [],
      scope: 'user',
      ...(keepRoot ? { stateRoot: data.stateRoot, webDataRoot: data.webDataRoot } : {}),
      updatedAt: new Date().toISOString(),
      version: ownership.receipt?.version ?? identity.version,
    }));
    remnantReceipt = receiptPath;
  }
  return Object.freeze({
    ...base,
    data: data.report,
    destination,
    receipt: receiptReport(receiptPath, ownership.receipt, ownership.status),
    registrations,
    ...(remnantReceipt === undefined ? {} : { remnantReceipt }),
    removed: Object.freeze({
      directories: Object.freeze([...purgedDirectories, ...directories]),
      files: Object.freeze(files),
    }),
    retained: retainedAfter,
    state: 'uninstalled',
  });
};

const readMarketplaceStagingIdentity = async (repoRoot: string, plugin: string): Promise<boolean> => {
  const manifest = await readInstalledManifest(cursorMarketplacePluginPath(repoRoot, plugin));
  if (manifest?.name !== plugin) return false;
  try {
    const document = JSON.parse(await readFile(join(repoRoot, '.cursor-plugin', 'marketplace.json'), 'utf8')) as unknown;
    return typeof document === 'object' && document !== null && !Array.isArray(document) &&
      (document as { readonly name?: unknown }).name === cursorMarketplaceName(plugin);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return false;
    throw error;
  }
};

/**
 * Why the staged repository's working tree is not the receipted commit's tree, or `undefined` when it is.
 * Same probe as Doctor's staging verifier (`--no-optional-locks` keeps it read-only; ignored entries count).
 * A repository that cannot be verified — git missing, or `status` failing — is reported as dirt too: the removal
 * is recursive, so "unverifiable" must not read as "clean".
 */
const stagedWorkingTreeDirt = async (runner: InstallCommandRunner, repoRoot: string): Promise<string | undefined> => {
  let result: InstallCommandResult;
  try {
    result = await runner.run(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
      { cwd: repoRoot },
    );
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'git is not available on PATH, so the staged working tree cannot be verified against the receipted commit.';
    throw error;
  }
  if (result.code !== 0) {
    return `\`git status\` failed in the staged repository (${result.stderr.trim() || `exit code ${result.code}`}), so its working tree cannot be verified against the receipted commit.`;
  }
  const entries = result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
  if (entries.length === 0) return undefined;
  const shown = entries.slice(0, 5).map((line) => JSON.stringify(line.slice(3))).join(', ');
  return `its working tree differs from the receipted commit (${entries.length} uncommitted, untracked, or ignored ` +
    `${entries.length === 1 ? 'entry' : 'entries'}: ${shown}${entries.length > 5 ? ', …' : ''}) that the receipt does not own.`;
};

const uninstallCursorMarketplace = async (
  options: UninstallBundleOptions,
  identity: PluginIdentity,
  policy: UninstallDataPolicy,
): Promise<UninstallResult> => {
  const force = options.force === true;
  const marketplace = cursorMarketplaceName(identity.plugin);
  const base = {
    bundleRoot: identity.bundleRoot,
    forced: force,
    host: 'cursor',
    marketplace,
    mode: 'marketplace',
    plugin: identity.plugin,
    scope: 'user',
    version: identity.version,
  } as const;
  const cursorRoot = join(options.home ?? homedir(), '.cursor');
  const marketplacesRoot = cursorMarketplaceRoot(cursorRoot);
  const repoRoot = join(marketplacesRoot, identity.plugin);
  const receiptPath = cursorMarketplaceReceiptPath(cursorRoot, identity.plugin);
  const data: UninstallDataReport = Object.freeze({
    detail: 'A staged marketplace repository holds no runtime state; a copy Cursor imported from it is Cursor-owned and is not touched.',
    outcome: 'unavailable',
    paths: Object.freeze([]),
    policy,
  });
  const cursorHome = await realDirectory(cursorRoot, 'cursor');
  const repo = cursorHome === undefined ? undefined : await realDirectory(repoRoot, 'cursor');
  const receipt = cursorHome === undefined ? undefined : await readInstallReceiptFile(receiptPath);
  if (repo === undefined && receipt === undefined) {
    return Object.freeze({
      ...base,
      data,
      destination: repoRoot,
      receipt: receiptReport(receiptPath, undefined, 'missing'),
      registrations: Object.freeze([Object.freeze({
        action: 'already-absent' as const,
        kind: 'cursor-marketplace-staging' as const,
        name: marketplace,
      })]),
      removed: Object.freeze({ directories: Object.freeze([]), files: Object.freeze([]) }),
      retained: Object.freeze([]),
      state: 'not-installed',
    });
  }
  let status: UninstallReceiptStatus = receipt === undefined
    ? 'forced-missing'
    : receipt.migratedFrom === undefined ? 'consumed' : 'migrated';
  const recorded = receipt?.registrations.find((registration) => registration.kind === 'cursor-marketplace-staging');
  if (repo !== undefined) {
    if (receipt === undefined) {
      if (!force) {
        throw failure(
          'AB7009',
          `Refusing to remove staged Cursor marketplace ${repoRoot} without an install receipt at ${receiptPath}. ` +
            'Re-run with --force to remove it after verifying it is this plugin\'s staging, or rerun ' +
            '`agent-bundle install cursor --mode marketplace` to record a receipt first.',
          'cursor',
        );
      }
      if (!await readMarketplaceStagingIdentity(repoRoot, identity.plugin)) {
        throw failure(
          'AB7007',
          `Refusing to remove ${repoRoot}: it is not a staged Agent Bundle marketplace for ${identity.plugin} ` +
            `(expected .cursor-plugin/marketplace.json naming ${marketplace} and plugins/${identity.plugin}). --force does not apply.`,
          'cursor',
        );
      }
    } else if (receipt.plugin !== identity.plugin) {
      throw failure(
        'AB7007',
        `Refusing to remove ${repoRoot}: the receipt at ${receiptPath} names plugin ${JSON.stringify(receipt.plugin)}.`,
        'cursor',
      );
    } else {
      const head = await readHeadCommit(repoRoot);
      if (recorded?.commit !== undefined && head !== recorded.commit) {
        if (!force) {
          throw failure(
            'AB7007',
            `Refusing to remove ${repoRoot}: its HEAD is ${head ?? 'unresolvable'} but the receipt recorded commit ` +
              `${recorded.commit}, so the staged repository changed after staging. Re-run with --force to remove it anyway.`,
            'cursor',
          );
        }
        status = 'forced-mismatch';
      } else if (recorded?.commit !== undefined) {
        // HEAD matching the receipt proves the commit, not the working tree: uncommitted, untracked, or ignored
        // entries someone added since staging are not receipt-owned, and the removal below is recursive.
        const dirty = await stagedWorkingTreeDirt(options.commandRunner ?? defaultCommandRunner, repoRoot);
        if (dirty !== undefined) {
          if (!force) {
            throw failure(
              'AB7007',
              `Refusing to remove ${repoRoot}: ${dirty} Move those entries out (or commit them and rerun ` +
                '`agent-bundle install cursor --mode marketplace`), or re-run with --force to remove them anyway.',
              'cursor',
            );
          }
          status = 'forced-mismatch';
        }
      }
    }
  }
  // A completed copy Cursor imported from the recorded staging commit is Cursor-owned, whether or not the
  // staged repository itself still exists: the receipt's commit — and the version the receipt recorded, not the
  // version the bundle has been rebuilt to since — is what identifies it.
  const imported = recorded?.commit !== undefined
    ? await cacheHasPlugin(options.home ?? homedir(), marketplace, identity.plugin, receipt?.version ?? identity.version, recorded.commit)
    : false;
  const planned = options.plan === true;
  const registrations: UninstallRegistrationReport[] = [Object.freeze({
    action: repo === undefined ? 'already-absent' as const : planned ? 'planned' as const : 'removed' as const,
    ...(recorded?.commit === undefined ? {} : { commit: recorded.commit }),
    kind: 'cursor-marketplace-staging' as const,
    name: marketplace,
  })];
  const nextSteps: string[] = [];
  if (imported) {
    registrations.push(Object.freeze({
      action: 'manual',
      detail: `Cursor imported this marketplace (a completed copy exists under ~/.cursor/plugins/cache/${marketplace}); ` +
        'its installed-plugin registry is server-assigned and exposes no non-interactive removal verb.',
      kind: 'cursor-marketplace-staging',
      name: marketplace,
    }));
    nextSteps.push(`Open Cursor, then Customize -> Plugins, and uninstall "${identity.plugin}" (marketplace ${marketplace}) there.`);
  }
  const files = receipt === undefined && !await exists(receiptPath) ? [] : [receiptPath];
  const directories = repo === undefined ? [] : [repoRoot];
  if (planned) {
    // Exactly the directories the run below would prune, in its order: the receipt store, the staging root, then
    // the Agent Bundle namespace once both are gone.
    const gone = new Set([...files, ...directories]);
    const namespace = join(cursorRoot, 'agent-bundle');
    const wouldPruneStore = await wouldPrune(installReceiptStoreDirectory(cursorRoot), gone) ? [installReceiptStoreDirectory(cursorRoot)] : [];
    const wouldPruneMarketplaces = await wouldPrune(marketplacesRoot, gone) ? [marketplacesRoot] : [];
    const wouldPruneNamespace = await wouldPrune(namespace, gone) ? [namespace] : [];
    return Object.freeze({
      ...base,
      data,
      destination: repoRoot,
      ...(nextSteps.length === 0 ? {} : { nextSteps: Object.freeze(nextSteps) }),
      receipt: receiptReport(receiptPath, receipt, status),
      registrations: Object.freeze(registrations),
      removed: Object.freeze({
        directories: Object.freeze([...directories, ...wouldPruneStore, ...wouldPruneMarketplaces, ...wouldPruneNamespace]),
        files: Object.freeze(files),
      }),
      retained: Object.freeze([]),
      state: 'planned',
    });
  }
  // The whole repository is installer-created (mkdtemp + rename), and the receipt just proved HEAD is
  // the commit that staging wrote (or --force accepted the difference): removing it wholesale is bounded.
  if (repo !== undefined) await rm(repoRoot, { force: true, recursive: true });
  const removedReceipt = await removeStoredInstallReceipt(receiptPath, cursorRoot);
  const prunedMarketplaces = await pruneEmptyDirectory(marketplacesRoot) ? [marketplacesRoot] : [];
  const prunedNamespace = await pruneEmptyDirectory(join(cursorRoot, 'agent-bundle')) ? [join(cursorRoot, 'agent-bundle')] : [];
  return Object.freeze({
    ...base,
    data,
    destination: repoRoot,
    ...(nextSteps.length === 0 ? {} : { nextSteps: Object.freeze(nextSteps) }),
    receipt: receiptReport(receiptPath, receipt, status),
    registrations: Object.freeze(registrations),
    removed: Object.freeze({
      directories: Object.freeze([
        ...directories,
        ...removedReceipt.filter((path) => path !== receiptPath),
        ...prunedMarketplaces,
        ...prunedNamespace,
      ]),
      files: Object.freeze(removedReceipt.filter((path) => path === receiptPath)),
    }),
    retained: Object.freeze([]),
    state: 'uninstalled',
  });
};

/**
 * What still depends on the marketplace once the `id`@`scope` copy is gone.
 * `others`: installed rows of other plugins from the same marketplace, plus
 * every other store receipt whose plugin installs from it (a Claude
 * project-scope install elsewhere is invisible to `plugin list --json` run
 * here, but its receipt is not). A receipt counts whether or not it records
 * the marketplace registration itself: an install made after the marketplace
 * already existed records only its plugin registration, and that plugin still
 * needs the marketplace. `sameOtherScopes`: (Claude) the same plugin installed
 * at another scope or in another project, from a live row, Claude's own
 * registry, or a stored receipt — it shares the marketplace, whose `remove`
 * applies to every scope, and the scope-less `plugins/data/<id>`. For Claude,
 * project- and local-scope installs made by hand in other projects have no
 * receipt and are invisible to `plugin list --json` run here, so the host's
 * cross-project registry `plugins/installed_plugins.json` is read as well: it
 * is where Claude records every scope of every install. A `plugin list --json`
 * or registry that cannot be read is `'unknown'`, never an empty list: a
 * failed read is not proof that nothing depends on the marketplace, so the
 * caller retains it (fail-closed).
 */
interface MarketplaceDependents {
  readonly others: readonly string[];
  /** The stored receipts among the dependents: where a retained marketplace's ownership claim can move to. */
  readonly receipts: readonly StoredInstallReceipt[];
  readonly sameOtherScopes: readonly string[];
}

const claudeInstalledPluginsRegistry = 'plugins/installed_plugins.json';

interface ClaudeInstalledPluginsEntry {
  readonly id: string;
  readonly projectPath: string | undefined;
  readonly scope: string;
}

/**
 * Claude's cross-scope, cross-project install registry (`{ plugins: { "<id>@<marketplace>": [{ scope, projectPath?, ... }] } }`).
 * Absent means Claude has never recorded an install into this config root (it writes the file on the first install and
 * leaves `{ "plugins": {} }` behind after the last uninstall); any other read or parse failure is `'unknown'`.
 */
const readClaudeInstalledPluginsRegistry = async (hostRoot: string): Promise<readonly ClaudeInstalledPluginsEntry[] | 'unknown'> => {
  let text: string;
  try {
    text = await readFile(join(hostRoot, claudeInstalledPluginsRegistry), 'utf8');
  } catch (error) {
    return isErrno(error, 'ENOENT') ? Object.freeze([]) : 'unknown';
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return 'unknown';
  }
  if (typeof document !== 'object' || document === null) return 'unknown';
  const plugins = (document as { readonly plugins?: unknown }).plugins;
  if (plugins === undefined) return Object.freeze([]);
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return 'unknown';
  const entries: ClaudeInstalledPluginsEntry[] = [];
  for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
    // Registry version 1 stored one object per id; version 2 stores one array of scoped installs per id.
    const installs = Array.isArray(value) ? value : [value];
    for (const install of installs) {
      if (typeof install !== 'object' || install === null) return 'unknown';
      const { projectPath, scope } = install as { readonly projectPath?: unknown; readonly scope?: unknown };
      if (typeof scope !== 'string' || (projectPath !== undefined && typeof projectPath !== 'string')) return 'unknown';
      entries.push(Object.freeze({ id, projectPath, scope }));
    }
  }
  return Object.freeze(entries);
};

const marketplaceDependents = async (
  runner: InstallCommandRunner,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  marketplace: string,
  id: string,
  scope: InstallScope,
  projectRoot: string | undefined,
  hostRoot: string,
  receiptPath: string,
): Promise<MarketplaceDependents | 'unknown'> => {
  const others: string[] = [];
  const sameOtherScopes: string[] = [];
  const seen = new Set<string>();
  try {
    const result = await runner.run(host, ['plugin', 'list', '--json'], { cwd: identity.bundleRoot });
    if (result.code !== 0) return 'unknown';
    const document = JSON.parse(result.stdout) as unknown;
    const rows = host === 'claude'
      ? document
      : typeof document === 'object' && document !== null ? (document as { readonly installed?: unknown }).installed : undefined;
    if (!Array.isArray(rows)) return 'unknown';
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const candidate = (row as { readonly id?: unknown; readonly pluginId?: unknown; readonly scope?: unknown });
      const rowId = host === 'claude' ? candidate.id : candidate.pluginId;
      if (typeof rowId !== 'string' || !rowId.endsWith(`@${marketplace}`)) continue;
      if (rowId !== id) {
        others.push(rowId);
        seen.add(rowId);
      } else if (host === 'claude' && typeof candidate.scope === 'string' && candidate.scope !== scope) {
        sameOtherScopes.push(`${rowId} (scope ${candidate.scope})`);
        seen.add(`${rowId}|${candidate.scope}`);
      }
    }
  } catch {
    return 'unknown';
  }
  if (host === 'claude') {
    const registry = await readClaudeInstalledPluginsRegistry(hostRoot);
    if (registry === 'unknown') return 'unknown';
    for (const entry of registry) {
      if (!entry.id.endsWith(`@${marketplace}`)) continue;
      if (entry.id !== id) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        others.push(`${entry.id} (scope ${entry.scope}${entry.projectPath === undefined ? '' : ` in ${entry.projectPath}`}, per ${claudeInstalledPluginsRegistry})`);
        continue;
      }
      // The copy being removed: same scope, and either no project or this project.
      if (entry.scope === scope && (entry.projectPath === undefined || projectRoot === undefined || entry.projectPath === projectRoot)) continue;
      const key = entry.projectPath === undefined ? `${entry.id}|${entry.scope}` : `${entry.id}|${entry.scope}|${entry.projectPath}`;
      if (seen.has(key) || (entry.projectPath !== undefined && seen.has(`${entry.id}|${entry.scope}`))) continue;
      seen.add(key);
      sameOtherScopes.push(`${entry.id} (scope ${entry.scope}${entry.projectPath === undefined ? '' : ` in ${entry.projectPath}`}, per ${claudeInstalledPluginsRegistry})`);
    }
  }
  const receipts: StoredInstallReceipt[] = [];
  const store = await listStoredInstallReceipts(hostRoot);
  // A store receipt that cannot be read may describe another install from this marketplace (or the one carrying
  // its ownership claim); a failed read is not proof that nothing depends on it, so the answer is unknown.
  if (store.unreadable.length > 0) return 'unknown';
  for (const stored of store.receipts) {
    if (stored.path === receiptPath || stored.receipt.host !== host) continue;
    const pluginRegistration = stored.receipt.registrations.find((registration) => registration.kind === `${host}-plugin`);
    const installsFromMarketplace = stored.receipt.registrations.some((registration) =>
      registration.kind === `${host}-marketplace` && registration.name === marketplace) ||
      (pluginRegistration?.id !== undefined && pluginRegistration.id.endsWith(`@${marketplace}`));
    if (!installsFromMarketplace) continue;
    receipts.push(stored);
    if (pluginRegistration?.id === id) {
      const where = stored.receipt.projectRoot === undefined ? '' : ` in ${stored.receipt.projectRoot}`;
      sameOtherScopes.push(`receipt ${stored.path} (scope ${stored.receipt.scope}${where})`);
    } else {
      others.push(`receipt ${stored.path}`);
    }
  }
  return Object.freeze({
    others: Object.freeze(others),
    receipts: Object.freeze(receipts),
    sameOtherScopes: Object.freeze(sameOtherScopes),
  });
};

const publicHostData = async (
  host: Exclude<InstallHost, 'cursor'>,
  policy: UninstallDataPolicy,
  entry: PublicHostInstalledEntry | undefined,
  hostRoot: string,
  id: string,
  sharedWith: readonly string[] | 'unknown',
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<UninstallDataReport> => {
  const paths: string[] = [];
  if (entry !== undefined) {
    const legacyStateRoot = join(entry.installPath, 'state');
    const effectiveState = await resolveInstalledStateRoot(entry.installPath, host, environment, home);
    const candidates = [
      effectiveState.root,
      ...(host === 'codex' && policy === 'keep' ? [] : [legacyStateRoot]),
      installedWebDataRoot(entry.installPath, home),
    ];
    for (const path of candidates) {
      if (!paths.includes(path) && await realDirectory(path, host) !== undefined) paths.push(path);
    }
  }
  if (host === 'claude') {
    const dataDirectory = join(hostRoot, 'plugins', 'data', id);
    if (await realDirectory(dataDirectory, host) !== undefined) paths.push(dataDirectory);
  }
  if (paths.length === 0) {
    if (host === 'codex' && entry !== undefined) {
      return Object.freeze({
        detail: policy === 'purge'
          ? '`codex plugin remove` deletes the cached plugin tree; no external framework state or web-data exists.'
          : '`codex plugin remove` deletes the cached plugin tree and Codex exposes no keep-data option; no external framework state or web-data exists to preserve.',
        outcome: policy === 'purge' ? 'removed-by-host' : 'unavailable',
        paths: Object.freeze([]),
        policy,
      });
    }
    return Object.freeze({
      detail: 'No durable runtime state exists for the installed copy.',
      outcome: 'absent',
      paths: Object.freeze([]),
      policy,
    });
  }
  if (policy === 'purge' && (sharedWith === 'unknown' || sharedWith.length > 0)) {
    // The cache copy and plugins/data/<id> are scope-less: another scope's install still uses them.
    throw failure(
      'AB7008',
      `Refusing --purge-data for ${id}: its durable state (${paths.join(', ')}) is shared with ` +
        (sharedWith === 'unknown'
          ? 'any other scope this plugin is installed at, and neither `claude plugin list --json` nor the Agent Bundle receipt store could be read to prove there is none'
          : `${sharedWith.join(', ')}, which stays installed`) +
        '. Uninstall this scope without --purge-data (the data is kept), and purge after the last scope is removed.',
      host,
    );
  }
  return Object.freeze({
    detail: policy === 'purge'
      ? `Durable runtime state is removed after the ${host} uninstall returns (--purge-data --confirm-purge).`
      : host === 'claude'
        ? '`claude plugin uninstall --keep-data` orphans the cached copy for Claude\'s ~14-day grace period; Agent Bundle preserves the effective framework state root, legacy state/, web-data, and plugins/data.'
        : '`codex plugin remove` deletes the cached plugin tree, but Agent Bundle preserves the external framework state root and web-data.',
    outcome: policy === 'purge' ? 'purged' : host === 'claude' ? 'retained-by-host' : 'kept',
    paths: Object.freeze(paths),
    policy,
  });
};

const uninstallPublicCli = async (
  options: UninstallBundleOptions,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  scope: InstallScope,
  policy: UninstallDataPolicy,
): Promise<UninstallResult> => {
  if (host === 'codex' && scope !== 'user') {
    throw failure('AB7003', `Codex plugin uninstallation supports only user scope, not ${scope}.`, host);
  }
  const marketplace = identity.marketplace;
  if (marketplace === undefined) throw failure('AB7001', `${host} bundle has no marketplace identity.`, host);
  const force = options.force === true;
  const runner = options.commandRunner ?? defaultCommandRunner;
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const hostRoot = publicHostRoot(host, environment, home);
  const id = `${identity.plugin}@${marketplace}`;
  const receiptPath = publicHostReceiptPath(host, identity.plugin, marketplace, scope, environment, home, publicHostProjectRoot(host, scope, identity));
  const receipt = await readInstallReceiptFile(receiptPath);
  const base = {
    bundleRoot: identity.bundleRoot,
    forced: force,
    host,
    marketplace,
    mode: 'host-cli',
    plugin: identity.plugin,
    scope,
    version: identity.version,
  } as const;
  const inventory = await readPublicHostInventory(runner, identity, host, scope, environment, home);
  if (inventory.status === 'unavailable') {
    throw failure(
      'AB7004',
      `Cannot uninstall ${id} from ${host} safely: \`${host} plugin list --json\` was unusable (${inventory.detail}).`,
      host,
    );
  }
  const entry = inventory.entries[0];
  if (entry === undefined && receipt === undefined) {
    return Object.freeze({
      ...base,
      data: Object.freeze({
        detail: 'Nothing is installed, so no durable runtime state is affected.',
        outcome: 'absent',
        paths: Object.freeze([]),
        policy,
      }),
      receipt: receiptReport(receiptPath, undefined, 'missing'),
      registrations: Object.freeze(publicHostRegistrations(host, id, marketplace, scope).map((registration) =>
        Object.freeze({ ...registration, action: 'already-absent' as const }))),
      removed: Object.freeze({ directories: Object.freeze([]), files: Object.freeze([]) }),
      retained: Object.freeze([]),
      state: 'not-installed',
    });
  }
  let status: UninstallReceiptStatus = receipt === undefined
    ? 'forced-missing'
    : receipt.migratedFrom === undefined ? 'consumed' : 'migrated';
  if (entry !== undefined) {
    if (receipt === undefined) {
      if (!force) {
        throw failure(
          'AB7009',
          `Refusing to uninstall ${id} from ${host}${entry.scope === undefined ? '' : ` (scope ${entry.scope})`}: the host ` +
            `reports it installed at ${entry.installPath} but no agent-bundle receipt exists at ${receiptPath}, so this ` +
            'install was not made by agent-bundle or predates lifecycle receipts. ' +
            `Re-run with --force to uninstall through \`${host} plugin ${host === 'claude' ? 'uninstall' : 'remove'}\` anyway.`,
          host,
        );
      }
    } else if (receipt.plugin !== identity.plugin) {
      throw failure('AB7007', `Refusing to uninstall: the receipt at ${receiptPath} names plugin ${JSON.stringify(receipt.plugin)}.`, host);
    } else {
      let installedHash: string | undefined;
      try {
        installedHash = (await installedBundleInventory(entry.installPath, host)).hash;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          if (!force) {
            throw failure(
              'AB7007',
              `Refusing to uninstall ${id}: the ${host} cached copy at ${entry.installPath} could not be compared with the ` +
                `receipt (${errorMessage(error)}). Re-run with --force to uninstall through the host CLI anyway.`,
              host,
            );
          }
          status = 'forced-mismatch';
        }
      }
      if (installedHash !== undefined && (installedHash !== receipt.contentHash || entry.version !== receipt.version)) {
        if (!force) {
          throw failure(
            'AB7007',
            `Refusing to uninstall ${id}: the ${host} cached copy at ${entry.installPath} is ${entry.version} with content ` +
              `${shortHash(installedHash)} but the receipt recorded ${receipt.version} with content ${shortHash(receipt.contentHash)}, ` +
              'so the installed copy was changed outside agent-bundle. Re-run with --force to uninstall it anyway.',
            host,
          );
        }
        status = 'forced-mismatch';
      }
    }
  }
  const defaults = publicHostRegistrations(host, id, marketplace, scope);
  const pluginRegistration = (receipt?.registrations ?? defaults).find((registration) => registration.kind === `${host}-plugin`);
  // The marketplace is Agent Bundle's to remove only when a receipt records that an install registered it.
  // Without that record (no receipt, or the marketplace pre-existed the install) it is retained and said so.
  const marketplaceRegistration = defaults.find((registration) => registration.kind === `${host}-marketplace`);
  const marketplaceOwned = receipt !== undefined &&
    receipt.registrations.some((registration) => registration.kind === `${host}-marketplace`);
  const marketplaceState = await readPublicHostMarketplaceState(runner, identity, host, marketplace);
  // Dependents decide both whether the marketplace goes and whether Claude's scope-less durable state may be
  // purged, so they are read whenever either decision is live — and always before any mutation.
  const dependents = marketplaceState !== 'absent' || (host === 'claude' && policy === 'purge')
    ? await marketplaceDependents(runner, identity, host, marketplace, id, scope, publicHostProjectRoot(host, scope, identity), hostRoot, receiptPath)
    : Object.freeze({ others: Object.freeze([]), receipts: Object.freeze([]), sameOtherScopes: Object.freeze([]) });
  const dependentNames = dependents === 'unknown' ? 'unknown' : [...dependents.others, ...dependents.sameOtherScopes];
  const retainMarketplace = !marketplaceOwned || marketplaceState === 'unknown' || dependentNames === 'unknown' ||
    dependentNames.length > 0;
  const planned = options.plan === true;
  // Consuming the receipt that records the marketplace registration while dependents keep the marketplace alive
  // would lose the only proof Agent Bundle created it, leaving the last uninstall to call it user-owned. The claim
  // moves to a dependent's receipt instead (the first one not already recording it); with no dependent receipt to
  // carry it — every dependent is a live row only — the loss is stated, not hidden.
  const ownershipHeir: StoredInstallReceipt | 'already-recorded' | 'none' | undefined =
    marketplaceOwned && retainMarketplace && marketplaceState !== 'absent' && dependents !== 'unknown'
      ? dependents.receipts.some((stored) => stored.receipt.registrations.some((registration) => registration.kind === `${host}-marketplace`))
        ? 'already-recorded'
        : dependents.receipts.length === 0 ? 'none' : dependents.receipts[0]
      : undefined;
  const ownershipDetail = ownershipHeir === undefined || ownershipHeir === 'already-recorded'
    ? ''
    : ownershipHeir === 'none'
      ? ' This receipt was the only record that Agent Bundle registered the marketplace and no dependent has a receipt to ' +
        'carry that claim, so after this uninstall the marketplace counts as user-owned: remove it by hand once nothing installs from it.'
      : ` The marketplace registration claim ${planned ? 'would move' : 'moves'} to receipt ${ownershipHeir.path} so the last ` +
        'uninstall can still remove it.';
  const data = await publicHostData(
    host,
    policy,
    entry,
    hostRoot,
    id,
    dependents === 'unknown' ? 'unknown' : dependents.sameOtherScopes,
    environment,
    home,
  );
  const registrations: UninstallRegistrationReport[] = [];
  if (pluginRegistration !== undefined) {
    registrations.push(Object.freeze({
      ...pluginRegistration,
      action: entry === undefined ? 'already-absent' : planned ? 'planned' : 'removed',
      detail: entry === undefined
        ? `${host} no longer lists ${id}${host === 'claude' ? ` at scope ${scope}` : ''}.`
        : `\`${host} ${publicHostUninstallArguments(host, id, scope).join(' ')}\``,
    }));
  }
  if (marketplaceRegistration !== undefined) {
    registrations.push(Object.freeze({
      ...marketplaceRegistration,
      action: marketplaceState === 'absent'
        ? 'already-absent'
        : retainMarketplace ? 'retained' : planned ? 'planned' : 'removed',
      detail: marketplaceState === 'absent'
        ? `${host} no longer lists marketplace ${marketplace}.`
        : !marketplaceOwned
          ? `Marketplace ${marketplace} stays registered: no Agent Bundle receipt records registering it, so it may have ` +
            `been configured by hand or before lifecycle receipts. Run \`${host} ${publicHostMarketplaceRemoveArguments(marketplace).join(' ')}\` ` +
            'yourself once nothing else installs from it.'
          : marketplaceState === 'unknown' || dependentNames === 'unknown'
            ? `Marketplace ${marketplace} stays registered: ` +
              (marketplaceState === 'unknown'
                ? `\`${host} plugin marketplace list --json\` could not be read`
                : `\`${host} plugin list --json\`, ${host === 'claude' ? `the ${claudeInstalledPluginsRegistry} registry, ` : ''}or a receipt in the Agent Bundle receipt store could not be read`) +
              ' to prove nothing else installs from it, and `plugin marketplace remove` applies to every scope. ' +
              'Remove it by hand once the inventory is readable.'
            : dependentNames.length > 0
              ? `Marketplace ${marketplace} stays registered: ${dependentNames.join(', ')} still install from it.${ownershipDetail}`
              : `\`${host} ${publicHostMarketplaceRemoveArguments(marketplace).join(' ')}\``,
    }));
  }
  const purgedDirectories = policy === 'purge' && data.outcome === 'purged' ? data.paths : [];
  const result = {
    ...base,
    data,
    ...(entry === undefined ? {} : { destination: entry.installPath }),
    receipt: receiptReport(receiptPath, receipt, status),
    registrations: Object.freeze(registrations),
    retained: Object.freeze([]),
  } as const;
  if (planned) {
    // The store pruning the run below performs, simulated: the receipt file, then the store directories it
    // leaves empty, so the plan names every path the completed result would.
    const wouldRemove = await simulateRemoveStoredInstallReceipt(receiptPath, hostRoot);
    return Object.freeze({
      ...result,
      removed: Object.freeze({
        directories: Object.freeze([...purgedDirectories, ...wouldRemove.filter((path) => path !== receiptPath)]),
        files: Object.freeze(wouldRemove.filter((path) => path === receiptPath)),
      }),
      state: 'planned',
    });
  }
  if (entry !== undefined) {
    await runHostCommand(runner, identity, host, publicHostUninstallArguments(host, id, scope), 'removal');
  }
  if (marketplaceState !== 'absent' && !retainMarketplace) {
    await runHostCommand(runner, identity, host, publicHostMarketplaceRemoveArguments(marketplace), 'removal');
  }
  for (const path of purgedDirectories) await rm(path, { force: true, recursive: true });
  if (ownershipHeir !== undefined && ownershipHeir !== 'already-recorded' && ownershipHeir !== 'none') {
    const heirRegistration = publicHostRegistrations(host, id, marketplace, ownershipHeir.receipt.scope)
      .find((registration) => registration.kind === `${host}-marketplace`);
    if (heirRegistration !== undefined) {
      await writeStoredInstallReceipt(ownershipHeir.path, {
        ...ownershipHeir.receipt,
        registrations: Object.freeze([...ownershipHeir.receipt.registrations, heirRegistration]),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  const removedReceipt = await removeStoredInstallReceipt(receiptPath, hostRoot);
  return Object.freeze({
    ...result,
    removed: Object.freeze({
      directories: Object.freeze([...purgedDirectories, ...removedReceipt.filter((path) => path !== receiptPath)]),
      files: Object.freeze(removedReceipt.filter((path) => path === receiptPath)),
    }),
    state: 'uninstalled',
  });
};

const uninstallProgram = Effect.fnUntraced(function*(
  options: UninstallBundleOptions,
): Effect.fn.Return<UninstallResult, unknown> {
  const scope = options.scope ?? 'user';
  if (options.mode !== undefined && options.host !== 'cursor') {
    return yield* Effect.fail(failure(
      'AB7003',
      `Uninstall mode ${JSON.stringify(options.mode)} applies to the cursor host only.`,
      options.host,
    ));
  }
  const policy = resolveDataPolicy(options);
  const identity = yield* liftPromise(() => readBundleIdentity(options.from, options.host));
  switch (options.host) {
    case 'claude':
      return yield* liftPromise(() => uninstallPublicCli(options, identity, 'claude', scope, policy));
    case 'codex':
      return yield* liftPromise(() => uninstallPublicCli(options, identity, 'codex', scope, policy));
    case 'cursor': {
      if (scope !== 'user') {
        return yield* Effect.fail(failure('AB7003', `Cursor plugin uninstallation supports only user scope, not ${scope}.`, 'cursor'));
      }
      // Cursor requires an existing home for install; uninstalling from a missing home is simply nothing to do.
      return yield* liftPromise(() => options.mode === 'marketplace'
        ? uninstallCursorMarketplace(options, identity, policy)
        : uninstallCursorLocal(options, identity, policy));
    }
    default: {
      const exhaustive: never = options.host;
      return yield* Effect.fail(failure('AB7000', `Unsupported uninstall host ${String(exhaustive)}.`, options.host));
    }
  }
});

/**
 * Uninstalls a plugin from a host, bounded by its install receipt. See the
 * module comment for the policy; `--plan` (`options.plan`) returns the same
 * report without changing anything.
 */
export const uninstallBundle = (options: UninstallBundleOptions): Promise<UninstallResult> =>
  runPromise(uninstallProgram(options));
