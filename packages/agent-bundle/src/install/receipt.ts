import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { exists, sameFile } from '../core/paths.ts';

/**
 * Host-agnostic install ownership core shared by `agent-bundle install`,
 * `agent-bundle doctor`, and the emitted standalone `install.mjs`: every copy
 * an agent-bundle installer places at a plugin root carries a receipt naming
 * the plugin, its version, the artifact content hash, and the exact files the
 * installer owns. Replacement removes or rewrites owned files only, so runtime
 * state that lands beside the plugin (`state/`) survives a same-version rebuild.
 */

/** Sidecar written at an installed plugin root by every agent-bundle installer. */
export const installReceiptFile = '.agent-bundle-install.json';

export const installReceiptFormat = 'agent-bundle-install-receipt/1';

/** Root entries owned by generated runtime code; installers never remove or rewrite them. */
export const preservedRuntimeEntries: readonly string[] = Object.freeze(['state']);

/**
 * Root files every emitted Cursor-compatible bundle carries. A receipt-less
 * copy with these files and a matching manifest name is a legacy agent-bundle
 * install (placed before receipts existed); anything else is foreign.
 */
export const installSurfaceMarkerFiles: readonly string[] = Object.freeze(['INSTALL.md', 'install.mjs']);

export interface InstallReceipt {
  readonly contentHash: string;
  readonly files: readonly string[];
  readonly format: typeof installReceiptFormat;
  readonly host: string;
  readonly installedAt: string;
  readonly plugin: string;
  readonly version: string;
}

export interface TreeInventory {
  /** Regular files in deterministic traversal order, POSIX-relative to the root. */
  readonly files: readonly string[];
  /** sha256 over `path\0bytes\0` for every file in `files`; the receipt is never included. */
  readonly hash: string;
}

export type InstalledTreeOwnership = 'foreign' | 'legacy' | 'receipt';

export type InstalledTreeStatus = 'current' | 'foreign' | 'stale' | 'version-mismatch';

export interface InstalledManifestIdentity {
  readonly name: string;
  readonly version?: string;
}

export interface InstalledTreeComparison {
  readonly artifactContentHash: string;
  readonly installedContentHash: string;
  readonly installedName?: string;
  readonly installedVersion?: string;
  readonly ownership: InstalledTreeOwnership;
  readonly receipt?: InstallReceipt;
  readonly status: InstalledTreeStatus;
}

const unsupportedEntry = (relativePath: string): Error =>
  new Error(`Refusing unsupported filesystem entry ${JSON.stringify(relativePath || '.')}.`);

const sortNames = (names: readonly string[]): readonly string[] =>
  [...names].sort((left, right) => left.localeCompare(right));

const toPosix = (path: string): string => path.replaceAll('\\', '/');

const hashEntry = (hash: ReturnType<typeof createHash>, relativePath: string, bytes: Uint8Array): void => {
  hash.update(toPosix(relativePath));
  hash.update('\0');
  hash.update(bytes);
  hash.update('\0');
};

/**
 * Walks a plugin tree the way the installers copy it: symlinks and special
 * files are refused, directories recurse in locale order, and the receipt at
 * the root is skipped so an installed copy hashes like the artifact it came from.
 */
export const treeInventory = async (root: string): Promise<TreeInventory> => {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw unsupportedEntry('.');
  const hash = createHash('sha256');
  const files: string[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    const path = join(root, relativePath);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw unsupportedEntry(relativePath);
    }
    if (metadata.isDirectory()) {
      for (const name of sortNames(await readdir(path))) await visit(join(relativePath, name));
      return;
    }
    files.push(toPosix(relativePath));
    hashEntry(hash, relativePath, await readFile(path));
  };
  for (const name of sortNames(await readdir(root))) {
    if (name === installReceiptFile) continue;
    await visit(name);
  }
  return Object.freeze({ files: Object.freeze(files), hash: hash.digest('hex') });
};

/**
 * Every directory on the way to a listed path must be a real directory: a
 * symlinked ancestor would let a leaf-only check read, hash, delete, or write
 * outside the plugin root (development installs point top-level directories
 * at generation folders, for example). Missing ancestors are fine.
 */
const assertRealAncestors = async (root: string, files: readonly string[]): Promise<void> => {
  const checked = new Set<string>();
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== '.' && directory !== '') {
      if (!checked.has(directory)) {
        checked.add(directory);
        try {
          const metadata = await lstat(join(root, directory));
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsupportedEntry(directory);
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
      }
      directory = dirname(directory);
    }
  }
};

/**
 * Hashes exactly the listed files (in list order) as they exist under root.
 * A missing owned file contributes nothing, so the digest differs from the
 * artifact digest whenever an owned file was removed or rewritten.
 */
export const hashOwnedFiles = async (root: string, files: readonly string[]): Promise<string> => {
  await assertRealAncestors(root, files);
  const hash = createHash('sha256');
  for (const relativePath of files) {
    const path = join(root, relativePath);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw unsupportedEntry(relativePath);
    hashEntry(hash, relativePath, await readFile(path));
  }
  return hash.digest('hex');
};

/**
 * Receipt paths drive deletions, so they must be exactly what `treeInventory`
 * emits: POSIX-relative, no backslashes (a Windows `..\outside` must not slip
 * past POSIX normalization), no empty, `.`, or `..` segments, no drive letter.
 */
export const isReceiptPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value !== installReceiptFile &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  !/^[a-z]:/iu.test(value) &&
  value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

const isReceiptFileList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isReceiptPath);

/** Reads the receipt at a plugin root; malformed or unsafe receipts read as absent. */
export const readInstallReceipt = async (destination: string): Promise<InstallReceipt | undefined> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as unknown;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record['format'] !== installReceiptFormat ||
    typeof record['plugin'] !== 'string' ||
    typeof record['version'] !== 'string' ||
    typeof record['host'] !== 'string' ||
    typeof record['contentHash'] !== 'string' ||
    typeof record['installedAt'] !== 'string' ||
    !isReceiptFileList(record['files'])
  ) {
    return undefined;
  }
  return Object.freeze({
    contentHash: record['contentHash'],
    files: Object.freeze([...record['files']]),
    format: installReceiptFormat,
    host: record['host'],
    installedAt: record['installedAt'],
    plugin: record['plugin'],
    version: record['version'],
  });
};

export const createInstallReceipt = (options: {
  readonly host: string;
  readonly installedAt?: string;
  readonly inventory: TreeInventory;
  readonly plugin: string;
  readonly version: string;
}): InstallReceipt => Object.freeze({
  contentHash: options.inventory.hash,
  files: options.inventory.files,
  format: installReceiptFormat,
  host: options.host,
  installedAt: options.installedAt ?? new Date().toISOString(),
  plugin: options.plugin,
  version: options.version,
});

const receiptDocument = (receipt: InstallReceipt): string => `${stableJson(receipt)}\n`;

/** Lands a receipt at a plugin root atomically (sibling temp file + rename). */
export const writeInstallReceipt = async (destination: string, receipt: InstallReceipt): Promise<void> => {
  const temporary = join(destination, `${installReceiptFile}.${process.pid}.tmp`);
  await writeFile(temporary, receiptDocument(receipt), 'utf8');
  try {
    await rename(temporary, join(destination, installReceiptFile));
  } finally {
    await rm(temporary, { force: true });
  }
};

const hasInstallSurfaceMarkers = async (destination: string): Promise<boolean> => {
  for (const marker of installSurfaceMarkerFiles) {
    if (!await exists(join(destination, marker))) return false;
  }
  return true;
};

/**
 * Decides whether an existing plugin root is this plugin's agent-bundle
 * install (receipt or legacy layout) or a foreign directory, and whether its
 * content matches the artifact. Symlinks anywhere in the installed tree are
 * refused, exactly like the copy paths.
 */
export const compareInstalledTree = async (options: {
  readonly artifact: TreeInventory;
  readonly destination: string;
  readonly installedManifest?: InstalledManifestIdentity;
  readonly plugin: string;
  readonly version: string;
}): Promise<InstalledTreeComparison> => {
  const rootMetadata = await lstat(options.destination);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw unsupportedEntry('.');
  const receipt = await readInstallReceipt(options.destination);
  const manifest = options.installedManifest;
  let ownership: InstalledTreeOwnership;
  let installedContentHash: string;
  if (receipt !== undefined && receipt.plugin === options.plugin) {
    ownership = 'receipt';
    installedContentHash = await hashOwnedFiles(options.destination, receipt.files);
  } else {
    installedContentHash = (await treeInventory(options.destination)).hash;
    ownership = receipt === undefined && manifest?.name === options.plugin && await hasInstallSurfaceMarkers(options.destination)
      ? 'legacy'
      : 'foreign';
  }
  const installedVersion = manifest?.version ?? (ownership === 'receipt' ? receipt?.version : undefined);
  const installedName = manifest?.name ?? (ownership === 'receipt' ? receipt?.plugin : undefined);
  const status: InstalledTreeStatus = installedContentHash === options.artifact.hash
    ? 'current'
    : ownership === 'foreign'
      ? 'foreign'
      : installedVersion !== undefined && installedVersion !== options.version
        ? 'version-mismatch'
        : 'stale';
  return Object.freeze({
    artifactContentHash: options.artifact.hash,
    installedContentHash,
    ...(installedName === undefined ? {} : { installedName }),
    ...(installedVersion === undefined ? {} : { installedVersion }),
    ownership,
    ...(ownership === 'receipt' && receipt !== undefined ? { receipt } : {}),
    status,
  });
};

/** Short hash prefix for operator-facing messages; full hashes ride the machine output. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

/** The operator-facing installed-versus-artifact sentence shared by installers and Doctor. */
export const describeContentComparison = (
  plugin: string,
  version: string,
  comparison: Pick<
    InstalledTreeComparison,
    'artifactContentHash' | 'installedContentHash' | 'installedName' | 'installedVersion' | 'status'
  >,
): string => {
  const installedVersion = comparison.installedVersion ?? 'unknown version';
  const verdict = comparison.status === 'current'
    ? 'same content'
    : comparison.installedVersion === undefined
      ? 'different content, installed version unknown'
      : comparison.installedVersion === version
        ? 'same version, different content'
        : 'different version';
  return `installed ${comparison.installedName ?? plugin}@${installedVersion} ` +
    `content ${shortHash(comparison.installedContentHash)} vs artifact ${plugin}@${version} ` +
    `content ${shortHash(comparison.artifactContentHash)} (${verdict})`;
};

export interface StagedArtifact {
  readonly inventory: TreeInventory;
  readonly parent: string;
  readonly root: string;
}

/**
 * Copies the artifact into a sibling staging directory on the destination's
 * filesystem (so every later `rename` is atomic), refuses symlinks, and lands
 * the receipt inside the staged copy.
 */
export const stageArtifact = async (options: {
  readonly artifactRoot: string;
  readonly destination: string;
  readonly receipt: { readonly host: string; readonly installedAt?: string; readonly plugin: string; readonly version: string };
  readonly stageRoot: string;
}): Promise<StagedArtifact> => {
  const parent = await mkdtemp(join(options.stageRoot, `.${basename(options.destination)}.stage-`));
  const root = join(parent, 'bundle');
  try {
    await cp(options.artifactRoot, root, {
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
    await rm(join(root, installReceiptFile), { force: true });
    const inventory = await treeInventory(root);
    await writeFile(
      join(root, installReceiptFile),
      receiptDocument(createInstallReceipt({ ...options.receipt, inventory })),
      'utf8',
    );
    return Object.freeze({ inventory, parent, root });
  } catch (error) {
    await rm(parent, { force: true, recursive: true });
    throw error;
  }
};

const pruneEmptyDirectories = async (destination: string, removedFiles: readonly string[]): Promise<void> => {
  const candidates = new Set<string>();
  for (const file of removedFiles) {
    let directory = dirname(file);
    while (directory !== '.' && directory !== '') {
      candidates.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...candidates].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(join(destination, directory));
    } catch (error) {
      if (!isErrno(error, 'ENOTEMPTY') && !isErrno(error, 'ENOENT') && !isErrno(error, 'EEXIST')) throw error;
    }
  }
};

const previouslyOwnedFiles = async (
  destination: string,
  comparison: InstalledTreeComparison,
): Promise<readonly string[]> => {
  if (comparison.ownership === 'receipt' && comparison.receipt !== undefined) return comparison.receipt.files;
  const inventory = await treeInventory(destination);
  return inventory.files.filter((file) => !preservedRuntimeEntries.includes(file.split('/')[0] ?? ''));
};

/**
 * Replaces an agent-bundle-owned install in place: stale owned files leave
 * first (their now-empty directories are pruned), every staged file then
 * moves over its predecessor with an atomic rename, and the receipt lands
 * last as the commit marker. Unowned entries are never touched; an incoming
 * file that would land on an existing unowned entry aborts before any change.
 */
export const replaceInstalledTree = async (options: {
  readonly comparison: InstalledTreeComparison;
  readonly destination: string;
  readonly staged: StagedArtifact;
}): Promise<void> => {
  if (options.comparison.ownership === 'foreign') {
    throw new Error(`Refusing to replace foreign install at ${options.destination}.`);
  }
  const incoming = new Set(options.staged.inventory.files);
  const previouslyOwned = await previouslyOwnedFiles(options.destination, options.comparison);
  await assertRealAncestors(options.destination, [...previouslyOwned, ...options.staged.inventory.files]);
  const owned = new Set(previouslyOwned);
  // On case-insensitive filesystems a case-only rename of an owned path resolves to the same
  // inode, so ownership is decided by file identity, not by name alone.
  let ownedIdentities: readonly Stats[] | undefined;
  const isOwnedIdentity = async (path: string): Promise<boolean> => {
    const candidate = await lstat(path);
    if (ownedIdentities === undefined) {
      const identities: Stats[] = [];
      for (const file of previouslyOwned) {
        try {
          identities.push(await lstat(join(options.destination, file)));
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
      }
      ownedIdentities = identities;
    }
    return ownedIdentities.some((metadata) => sameFile(metadata, candidate));
  };
  const collisions: string[] = [];
  for (const file of options.staged.inventory.files) {
    if (owned.has(file)) continue;
    const target = join(options.destination, file);
    if (await exists(target) && !await isOwnedIdentity(target)) collisions.push(file);
  }
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to overwrite unowned files at ${options.destination}: ${collisions.join(', ')}. ` +
        'Move them aside manually before replacing.',
    );
  }
  const stale = previouslyOwned.filter((file) => !incoming.has(file));
  for (const file of stale) {
    await rm(join(options.destination, file), { force: true });
  }
  await pruneEmptyDirectories(options.destination, stale);
  for (const file of options.staged.inventory.files) {
    const target = join(options.destination, file);
    await mkdir(dirname(target), { recursive: true });
    await rename(join(options.staged.root, file), target);
  }
  await rename(join(options.staged.root, installReceiptFile), join(options.destination, installReceiptFile));
};
