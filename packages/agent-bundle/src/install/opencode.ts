import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { errorMessage, isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import {
  bundleInventory,
  failure,
  type PluginIdentity,
} from './identity.ts';
import type { InstallBundleOptions, InstallResult, InstallScope } from './install.ts';
import {
  assertRealAncestors,
  compareInstalledTree,
  createInstallReceipt,
  describeContentComparison,
  emptyContentHash,
  hashOwnedFiles,
  installReceiptFile,
  isRemnantReceipt,
  stageArtifact,
  replaceInstalledTree,
  readInstallReceipt,
  writeInstallReceipt,
  type InstallReceiptIdentity,
  type InstalledTreeComparison,
} from './receipt.ts';
import type { UninstallBundleOptions, UninstallDataPolicy, UninstallResult } from './uninstall.ts';
import { listRetained, pruneDirectories, receiptReport, simulatePrune } from './directory-lifecycle.ts';

export interface OpenCodeLocationOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly home?: string;
  readonly projectRoot?: string;
}

export interface OpenCodeInstallLocation {
  readonly destination: string;
  readonly hostDirectories: readonly string[];
  readonly hostRoot: string;
  readonly installRoot: string;
  readonly relativeDestination: string;
  readonly registration: 'opencode-project-plugin' | 'opencode-user-plugin';
}

export const openCodeInstallLocation = (
  options: OpenCodeLocationOptions,
  identity: Pick<PluginIdentity, 'plugin'>,
  scope: InstallScope,
): OpenCodeInstallLocation => {
  if (scope === 'local') {
    throw failure('AB7003', 'OpenCode plugin installation supports project or user scope, not local.', 'opencode');
  }
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const configHome = environment['XDG_CONFIG_HOME'] ?? join(home, '.config');
  const hostRoot = scope === 'project'
    ? resolve(options.projectRoot ?? process.cwd())
    : join(configHome, 'opencode');
  const installRoot = scope === 'project'
    ? join(hostRoot, '.opencode', 'plugins')
    : join(hostRoot, 'plugins');
  const relativeDestination = `${scope === 'project' ? '.opencode/plugins' : 'plugins'}/${identity.plugin}`;
  return Object.freeze({
    destination: join(hostRoot, relativeDestination),
    hostDirectories: Object.freeze(scope === 'project' ? ['.opencode', '.opencode/plugins'] : ['plugins']),
    hostRoot,
    installRoot,
    relativeDestination,
    registration: scope === 'project' ? 'opencode-project-plugin' : 'opencode-user-plugin',
  });
};

const collisionFailure = (location: OpenCodeInstallLocation, identity: PluginIdentity, comparison: InstalledTreeComparison): Error =>
  failure(
    'AB7005',
    `Cannot install OpenCode plugin ${identity.plugin} at ${location.destination}: ${describeContentComparison(identity.plugin, identity.version, comparison)}.`,
    'opencode',
  );

export const installOpenCode = async (
  options: InstallBundleOptions,
  identity: PluginIdentity,
  scope: InstallScope,
): Promise<InstallResult> => {
  if (identity.documents.plugin !== 'package.json' || identity.documents.entry !== 'index.js') {
    throw failure('AB7001', 'The OpenCode projection must point at package.json and index.js in the artifact root.', 'opencode');
  }
  if (resolve(identity.bundleRoot) === resolve(openCodeInstallLocation(options, identity, scope).destination)) {
    throw failure(
      'AB7005',
      'The OpenCode source directory is already the install destination; use a separate artifact output so the installer does not rewrite built bytes.',
      'opencode',
    );
  }
  const artifact = await bundleInventory(identity, { restoreModes: true });
  const location = openCodeInstallLocation(options, identity, scope);
  const base = {
    bundleRoot: identity.bundleRoot,
    contentHash: artifact.hash,
    destination: location.destination,
    host: 'opencode',
    mode: 'local',
    nextSteps: Object.freeze(['Run OpenCode from the target project; new sessions discover the installed package.']),
    plugin: identity.plugin,
    receipt: join(location.destination, installReceiptFile),
    version: identity.version,
  } as const;
  await assertRealAncestors(location.hostRoot, [`${location.relativeDestination}/index.js`]);
  const created: string[] = [];
  for (const relativePath of location.hostDirectories) {
    if (!await exists(join(location.hostRoot, relativePath))) created.push(relativePath);
  }
  await mkdir(location.installRoot, { recursive: true });
  const receipt: InstallReceiptIdentity = {
    host: 'opencode',
    hostDirectories: created,
    mode: 'local',
    plugin: identity.plugin,
    registrations: [{ kind: location.registration }],
    scope,
    version: identity.version,
  };
  if (!await exists(location.destination)) {
    const staged = await stageArtifact({
      artifactRoot: identity.bundleRoot,
      destination: location.destination,
      inventory: artifact,
      receipt,
      stageRoot: location.installRoot,
    });
    try {
      await rename(staged.root, location.destination);
    } finally {
      await rm(staged.parent, { force: true, recursive: true });
    }
    return { ...base, state: 'installed' };
  }
  const comparison = await compareInstalledTree({
    artifact,
    destination: location.destination,
    plugin: identity.plugin,
    version: identity.version,
  });
  const remnant = comparison.receipt !== undefined && isRemnantReceipt(comparison.receipt);
  if (comparison.status === 'current') return { ...base, state: 'already-installed' };
  const replaceable = comparison.ownership === 'receipt' && remnant || comparison.status === 'stale' && comparison.ownership === 'receipt' || options.replace === true && comparison.ownership === 'receipt';
  if (!replaceable) throw collisionFailure(location, identity, comparison);
  const replacement: InstallReceiptIdentity = {
    ...receipt,
    hostDirectories: comparison.receipt?.hostDirectories ?? [],
  };
  const staged = await stageArtifact({
    artifactRoot: identity.bundleRoot,
    destination: location.destination,
    inventory: artifact,
    receipt: replacement,
    stageRoot: location.installRoot,
  });
  try {
    await replaceInstalledTree({ comparison, destination: location.destination, receipt: replacement, staged });
  } finally {
    await rm(staged.parent, { force: true, recursive: true });
  }
  if (remnant) return { ...base, state: 'installed' };
  return {
    ...base,
    previousContentHash: comparison.installedContentHash,
    state: 'replaced',
  };
};

const realDirectory = async (path: string): Promise<boolean> => {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw failure('AB7009', `Refusing OpenCode lifecycle entry ${path}: expected a real directory, not a symlink or other entry.`, 'opencode');
  }
  return true;
};

export const uninstallOpenCode = async (
  options: UninstallBundleOptions,
  identity: PluginIdentity,
  scope: InstallScope,
  policy: UninstallDataPolicy,
): Promise<UninstallResult> => {
  const location = openCodeInstallLocation(options, identity, scope);
  await assertRealAncestors(location.hostRoot, [`${location.relativeDestination}/index.js`]);
  const force = options.force === true;
  const receiptPath = join(location.destination, installReceiptFile);
  const receipt = await readInstallReceipt(location.destination);
  const base = {
    bundleRoot: identity.bundleRoot,
    data: Object.freeze({
      detail: policy === 'purge'
        ? 'OpenCode package state is unowned and therefore cannot be purged; remove retained state manually.'
        : 'OpenCode package state and unowned files are retained.',
      outcome: policy === 'purge' ? 'retained-by-host' as const : 'kept' as const,
      paths: Object.freeze([]),
      policy,
    }),
    destination: location.destination,
    forced: force,
    host: 'opencode',
    mode: 'local' as const,
    plugin: identity.plugin,
    scope,
    version: identity.version,
  } as const;
  if (!await realDirectory(location.destination)) {
    return Object.freeze({
      ...base,
      receipt: receiptReport(receiptPath, undefined, 'missing'),
      registrations: Object.freeze([Object.freeze({ action: 'already-absent' as const, kind: location.registration })]),
      removed: Object.freeze({ directories: Object.freeze([]), files: Object.freeze([]) }),
      retained: Object.freeze([]),
      state: 'not-installed',
    });
  }
  if (receipt === undefined) {
    throw failure(
      'AB7009',
      `Refusing to uninstall OpenCode plugin directory ${location.destination}: no Agent Bundle install receipt exists, so none of its files is proven owned.`,
      'opencode',
    );
  }
  if (receipt.host !== 'opencode' || receipt.plugin !== identity.plugin || receipt.scope !== scope || (!isRemnantReceipt(receipt) && !receipt.registrations.some((entry) => entry.kind === location.registration))) {
    throw failure(
      'AB7007',
      `Refusing to uninstall OpenCode plugin directory ${location.destination}: its receipt does not match this plugin, scope, and registration.`,
      'opencode',
    );
  }
  const installedHash = await hashOwnedFiles(location.destination, receipt.files);
  const status = installedHash === receipt.contentHash ? 'consumed' as const : 'forced-mismatch' as const;
  if (installedHash !== receipt.contentHash && !force) {
    throw failure(
      'AB7007',
      `Refusing to uninstall OpenCode plugin directory ${location.destination}: owned content changed after installation. Re-run with --force to remove only receipt-owned files.`,
      'opencode',
    );
  }
  await assertRealAncestors(location.destination, receipt.files);
  const retained = await listRetained(location.destination, new Set(receipt.files), new Set(receipt.directories));
  const files = [...receipt.files.map((file) => join(location.destination, file)), receiptPath];
  const retainedReceipt = retained.length > 0;
  const filesToRemove = retainedReceipt ? files.filter((path) => path !== receiptPath) : files;
  const internalDirectories = receipt.directories.map((directory) => join(location.destination, directory));
  const hostDirectories = receipt.hostDirectories.map((directory) => join(location.hostRoot, directory));
  const registration = Object.freeze({
    action: options.plan === true ? 'planned' as const : 'removed' as const,
    detail: 'The receipt-owned native OpenCode V2 package is removed; unrelated configuration and retained state are untouched.',
    kind: location.registration,
  });
  const result = {
    ...base,
    receipt: receiptReport(receiptPath, receipt, retainedReceipt ? 'remnant' : status),
    registrations: Object.freeze([registration]),
    retained: Object.freeze(retained),
  };
  const directoryCandidates = [...internalDirectories, location.destination, ...hostDirectories];
  if (options.plan === true) {
    const directories = await simulatePrune(directoryCandidates, new Set(filesToRemove));
    return Object.freeze({
      ...result,
      removed: Object.freeze({ directories: Object.freeze(directories), files: Object.freeze(filesToRemove) }),
      state: 'planned',
    });
  }
  try {
    for (const file of receipt.files) await rm(join(location.destination, file), { force: true });
    await rm(receiptPath, { force: true });
  } catch (error) {
    throw failure('AB7007', errorMessage(error), 'opencode');
  }
  if (retainedReceipt) {
    await writeInstallReceipt(location.destination, createInstallReceipt({
      directories: [],
      host: 'opencode',
      hostDirectories: receipt.hostDirectories,
      installedAt: receipt.installedAt,
      inventory: { files: [], hash: emptyContentHash },
      mode: receipt.mode,
      plugin: receipt.plugin,
      registrations: [],
      scope: receipt.scope,
      updatedAt: new Date().toISOString(),
      version: receipt.version,
    }));
  }
  const removedDirectories = await pruneDirectories(directoryCandidates);
  return Object.freeze({
    ...result,
    removed: Object.freeze({ directories: Object.freeze(removedDirectories), files: Object.freeze(filesToRemove) }),
    state: 'uninstalled',
  });
};
