import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';

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
 * Whether a root entry name is a preserved runtime root. Matched
 * case-insensitively: on case-insensitive filesystems `State/` *is* `state/`,
 * so no spelling of a runtime root may be inventoried, staged, or claimed by a
 * receipt.
 */
export const isPreservedRuntimeRoot = (name: string): boolean =>
  preservedRuntimeEntries.includes(name.toLowerCase());

/**
 * Root files every emitted Cursor-compatible bundle carries. A receipt-less
 * copy with these files and a matching manifest name is a legacy agent-bundle
 * install (placed before receipts existed); anything else is foreign.
 */
export const installSurfaceMarkerFiles: readonly string[] = Object.freeze(['INSTALL.md', 'install.mjs']);

export interface InstallReceipt {
  readonly contentHash: string;
  /**
   * Directories the installer created (POSIX-relative, sorted). Only these
   * are ever pruned when they empty out; a directory that existed before the
   * installer wrote beneath it belongs to whoever made it.
   */
  readonly directories: readonly string[];
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

/** Every ancestor directory of the given POSIX-relative files, deduplicated and sorted. */
export const directoriesOf = (files: readonly string[]): readonly string[] => {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== '.' && directory !== '') {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return Object.freeze(sortNames([...directories]));
};

/**
 * `path\0mode\0bytes\0` per file, where mode is `x` for an executable and `-`
 * otherwise: a rebuild that only flips the executable bit on an MCP script is
 * a content change the host must receive.
 */
const hashEntry = (
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  metadata: Stats,
  bytes: Uint8Array,
): void => {
  hash.update(toPosix(relativePath));
  hash.update('\0');
  hash.update((metadata.mode & 0o111) === 0 ? '-' : 'x');
  hash.update('\0');
  hash.update(bytes);
  hash.update('\0');
};

/**
 * Walks a plugin tree the way the installers copy it: symlinks and special
 * files are refused, directories recurse in locale order, and the receipt at
 * the root is skipped so an installed copy hashes like the artifact it came from.
 * Only regular files are content: an empty directory is neither hashed nor
 * installed, so adding one to an artifact changes nothing.
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
    // Every inventoried path must round-trip through a receipt unchanged: a POSIX name holding a
    // backslash would be rewritten into a separator, and a name the receipt reader rejects
    // (reserved characters, trailing dot or space, ...) could never be owned. Refuse them up front.
    const posixPath = toPosix(relativePath);
    if ((sep === '/' && relativePath.includes('\\')) || !isReceiptPath(posixPath)) {
      throw unsupportedEntry(sep === '/' ? relativePath : posixPath);
    }
    files.push(posixPath);
    hashEntry(hash, relativePath, metadata, await readFile(path));
  };
  for (const name of sortNames(await readdir(root))) {
    if (name === installReceiptFile) {
      // The receipt is deletion authority; it is skipped from the hash but must be a regular file.
      if (!(await lstat(join(root, name))).isFile()) throw unsupportedEntry(name);
      continue;
    }
    // Runtime-owned roots (`state/`) are never plugin content: not hashed, not installed, not owned,
    // whether they sit in an installed copy or in an artifact that was run in place.
    if (isPreservedRuntimeRoot(name)) continue;
    await visit(name);
  }
  return Object.freeze({ files: Object.freeze(files), hash: hash.digest('hex') });
};

/**
 * Whether an existing entry at `relativePath` is one of the previously owned
 * files: the exact recorded name, or — on case-insensitive filesystems — a
 * case alias of a recorded name. An alias is proven by the filesystem itself:
 * both spellings canonicalise (`realpath`, on-disk casing) to the same path.
 * Inode equality is deliberately not used: two distinct entries `Foo` and
 * `foo` hard-linked together on a case-sensitive filesystem are not aliases,
 * and an operator hard link under an unrelated name is not ours either.
 * Ancestors have already been proven symlink-free before this runs.
 */
const isOwnedEntry = async (
  root: string,
  owned: ReadonlySet<string>,
  relativePath: string,
): Promise<boolean> => {
  if (owned.has(relativePath)) return true;
  const alias = relativePath.toLowerCase();
  let canonical: string | undefined;
  for (const candidate of owned) {
    if (candidate.toLowerCase() !== alias) continue;
    try {
      canonical ??= await realpath(join(root, relativePath));
      if (await realpath(join(root, candidate)) === canonical) return true;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
  return false;
};

/**
 * Every directory on the way to a listed path must be a real directory: a
 * symlinked ancestor would let a leaf-only check read, hash, delete, or write
 * outside the plugin root (development installs point top-level directories
 * at generation folders, for example). Missing ancestors are fine, and so is
 * an owned regular file that a rebuild turns into a directory: it leaves as
 * stale before anything is written beneath it.
 */
const assertRealAncestors = async (
  root: string,
  files: readonly string[],
  ownedFiles: ReadonlySet<string> = new Set(),
): Promise<void> => {
  const checked = new Set<string>();
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== '.' && directory !== '') {
      if (!checked.has(directory)) {
        checked.add(directory);
        try {
          const metadata = await lstat(join(root, directory));
          if (metadata.isSymbolicLink()) throw unsupportedEntry(directory);
          if (
            !metadata.isDirectory() &&
            !(metadata.isFile() && await isOwnedEntry(root, ownedFiles, directory))
          ) {
            throw unsupportedEntry(directory);
          }
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
    hashEntry(hash, relativePath, metadata, await readFile(path));
  }
  return hash.digest('hex');
};

/**
 * Receipt paths drive deletions, so they must be exactly what `treeInventory`
 * emits: POSIX-relative, no backslashes (a Windows `..\outside` must not slip
 * past POSIX normalization), no empty, `.`, or `..` segments, no drive letter,
 * and no segment Windows would normalise onto another entry (reserved
 * characters, alternate-stream colons, trailing dots or spaces).
 */
export const isReceiptPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  // The receipt's own name is reserved as a top-level entry in every spelling, file or directory:
  // on a case-insensitive filesystem an alias resolves to the receipt itself, so nothing at or
  // beneath it can be owned content or be installed.
  (value.split('/')[0] ?? '').toLowerCase() !== installReceiptFile.toLowerCase() &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  // Runtime roots are never installer-owned, whatever a receipt claims and however it spells them.
  !isPreservedRuntimeRoot(value.split('/')[0] ?? '') &&
  value.split('/').every((segment) =>
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !/[<>:"|?*]/u.test(segment) &&
    [...segment].every((character) => character.charCodeAt(0) >= 0x20) &&
    !segment.endsWith('.') &&
    !segment.endsWith(' '));

const isReceiptFileList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isReceiptPath);

/**
 * Reads the receipt at a plugin root; malformed or unsafe receipts read as
 * absent. A receipt that is not a regular file (a symbolic link, a FIFO, a
 * device) is refused outright before it is read: it would let another file
 * supply the owned-file list that drives deletions, or block the read.
 */
export const readInstallReceipt = async (destination: string): Promise<InstallReceipt | undefined> => {
  const path = join(destination, installReceiptFile);
  let value: unknown;
  try {
    if (!(await lstat(path)).isFile()) throw unsupportedEntry(installReceiptFile);
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
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
    !isReceiptFileList(record['files']) ||
    !isReceiptFileList(record['directories'])
  ) {
    return undefined;
  }
  return Object.freeze({
    contentHash: record['contentHash'],
    directories: Object.freeze([...record['directories']]),
    files: Object.freeze([...record['files']]),
    format: installReceiptFormat,
    host: record['host'],
    installedAt: record['installedAt'],
    plugin: record['plugin'],
    version: record['version'],
  });
};

/**
 * Builds a receipt for an inventory. `directories` defaults to every ancestor
 * of the inventoried files — right for a fresh install, where the installer
 * created all of them; callers that adopt or replace an existing tree pass
 * exactly the directories they created.
 */
export const createInstallReceipt = (options: {
  readonly directories?: readonly string[];
  readonly host: string;
  readonly installedAt?: string;
  readonly inventory: TreeInventory;
  readonly plugin: string;
  readonly version: string;
}): InstallReceipt => Object.freeze({
  contentHash: options.inventory.hash,
  directories: options.directories ?? directoriesOf(options.inventory.files),
  files: options.inventory.files,
  format: installReceiptFormat,
  host: options.host,
  installedAt: options.installedAt ?? new Date().toISOString(),
  plugin: options.plugin,
  version: options.version,
});

const receiptDocument = (receipt: InstallReceipt): string => `${stableJson(receipt)}\n`;

/**
 * Lands a receipt at a plugin root atomically: an exclusively created,
 * randomly named sibling (`wx` never follows an existing link or overwrites
 * a file) renamed into place.
 */
export const writeInstallReceipt = async (destination: string, receipt: InstallReceipt): Promise<void> => {
  const temporary = join(destination, `${installReceiptFile}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(receiptDocument(receipt), 'utf8');
    await handle.close();
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
  // A receipt-managed tree is current only when its recorded inventory matches too: an owned file
  // that vanished while the rebuild dropped it hashes equal, but the receipt must still be refreshed
  // so a later unowned file at that path is never mistaken for stale owned content.
  const inventoryMatches = ownership !== 'receipt' ||
    (receipt !== undefined &&
      receipt.files.length === options.artifact.files.length &&
      receipt.files.every((file, index) => file === options.artifact.files[index]));
  // Foreign ownership wins over byte equality: a directory that is not ours is never "current".
  const status: InstalledTreeStatus = ownership === 'foreign'
    ? 'foreign'
    : installedContentHash === options.artifact.hash && inventoryMatches
      ? 'current'
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
  const sameContent = comparison.installedContentHash === comparison.artifactContentHash;
  const verdict = comparison.installedVersion === undefined
    ? sameContent ? 'same content, installed version unknown' : 'different content, installed version unknown'
    : comparison.installedVersion === version
      ? sameContent ? 'same content' : 'same version, different content'
      : sameContent ? 'same content, different version' : 'different version';
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
    // Exactly the inventoried content is copied: runtime roots and a stray receipt never are (a
    // run-in-place artifact may hold a large live database), and neither are empty directories —
    // they carry no plugin content, so they are not hashed, not installed, and not owned, and the
    // installed tree, its receipt, and the artifact hash all describe the same set of entries.
    const artifactRoot = resolve(options.artifactRoot);
    const source = await treeInventory(artifactRoot);
    const content = new Set([...source.files, ...directoriesOf(source.files)]);
    await cp(artifactRoot, root, {
      errorOnExist: true,
      filter: (entry) => {
        const relativePath = relative(artifactRoot, entry);
        return relativePath === '' || content.has(toPosix(relativePath));
      },
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
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

/**
 * Removes the now-empty ancestors of removed files, deepest first, but only
 * those the installer created: a pre-existing directory that merely became an
 * ancestor of an owned file is not ours to delete. Returns what was pruned.
 */
const pruneEmptyDirectories = async (
  destination: string,
  removedFiles: readonly string[],
  ownedDirectories: ReadonlySet<string>,
): Promise<ReadonlySet<string>> => {
  const pruned = new Set<string>();
  const candidates = directoriesOf(removedFiles).filter((directory) => ownedDirectories.has(directory));
  for (const directory of [...candidates].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(join(destination, directory));
      pruned.add(directory);
    } catch (error) {
      if (!isErrno(error, 'ENOTEMPTY') && !isErrno(error, 'ENOENT') && !isErrno(error, 'EEXIST')) throw error;
    }
  }
  return pruned;
};

/**
 * Creates the missing ancestors of a target path one level at a time and
 * reports the ones this call created, so the receipt can own exactly those.
 */
const ensureAncestors = async (
  destination: string,
  file: string,
  created: Set<string>,
): Promise<void> => {
  const ancestors: string[] = [];
  let directory = dirname(file);
  while (directory !== '.' && directory !== '') {
    ancestors.unshift(directory);
    directory = dirname(directory);
  }
  for (const ancestor of ancestors) {
    if (created.has(ancestor)) continue;
    try {
      await mkdir(join(destination, ancestor));
      created.add(ancestor);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
  }
};

/**
 * What the previous installer owned. A receipt says so exactly. A legacy copy
 * has no inventory, so only the files the new artifact also ships count as
 * owned: they are rewritten, everything else (operator files, stale artifact
 * files, `state/`) is left in place and stays unowned under the new receipt.
 */
const previouslyOwnedFiles = async (
  destination: string,
  comparison: InstalledTreeComparison,
  incoming: ReadonlySet<string>,
): Promise<readonly string[]> => {
  if (comparison.ownership === 'receipt' && comparison.receipt !== undefined) return comparison.receipt.files;
  const inventory = await treeInventory(destination);
  const owned: string[] = [];
  for (const file of inventory.files) {
    // Exact match, or a case alias of an incoming path on case-insensitive filesystems.
    if (await isOwnedEntry(destination, incoming, file)) owned.push(file);
  }
  return owned;
};

/**
 * True when a directory is entirely previous-installer territory: the
 * directory and every directory beneath it were created by the installer, it
 * holds at least one file, every file is owned, and no directory anywhere
 * beneath is empty (an empty directory is no evidence of ownership and would
 * survive pruning). Only such a directory may make way for an incoming file.
 */
const isWhollyOwnedDirectory = async (
  destination: string,
  relativePath: string,
  owned: ReadonlySet<string>,
  ownedDirectories: ReadonlySet<string>,
): Promise<boolean> => {
  let files = 0;
  const visit = async (directory: string): Promise<boolean> => {
    if (!await isOwnedEntry(destination, ownedDirectories, directory)) return false;
    const entries = sortNames(await readdir(join(destination, directory)));
    if (entries.length === 0) return false;
    for (const name of entries) {
      const relative = `${directory}/${name}`;
      const metadata = await lstat(join(destination, relative));
      if (metadata.isSymbolicLink()) throw unsupportedEntry(relative);
      if (metadata.isDirectory()) {
        if (!await visit(relative)) return false;
        continue;
      }
      if (!metadata.isFile() || !await isOwnedEntry(destination, owned, relative)) return false;
      files += 1;
    }
    return true;
  };
  return await visit(relativePath) && files > 0;
};

/**
 * Directories the previous installer created. A receipt says so exactly; a
 * legacy copy has no inventory, so none of its directories are ours.
 */
const previouslyOwnedDirectories = (comparison: InstalledTreeComparison): readonly string[] =>
  comparison.ownership === 'receipt' && comparison.receipt !== undefined ? comparison.receipt.directories : [];

/**
 * Replaces an agent-bundle-owned install in place: stale owned files leave
 * first (their now-empty installer-created directories are pruned), every
 * staged file then moves over its predecessor with an atomic rename, and the
 * receipt — recording the files and the directories the installer owns after
 * this replacement — lands last as the commit marker. Unowned entries,
 * including directories that existed before the installer wrote beneath
 * them, are never touched; an incoming file that would land on an existing
 * unowned entry aborts before any change.
 */
export const replaceInstalledTree = async (options: {
  readonly comparison: InstalledTreeComparison;
  readonly destination: string;
  readonly receipt: { readonly host: string; readonly installedAt?: string; readonly plugin: string; readonly version: string };
  readonly staged: StagedArtifact;
}): Promise<void> => {
  if (options.comparison.ownership === 'foreign') {
    throw new Error(`Refusing to replace foreign install at ${options.destination}.`);
  }
  const incoming = new Set(options.staged.inventory.files);
  const previouslyOwned = await previouslyOwnedFiles(options.destination, options.comparison, incoming);
  const owned = new Set(previouslyOwned);
  const ownedDirectories = new Set(previouslyOwnedDirectories(options.comparison));
  await assertRealAncestors(options.destination, previouslyOwned);
  await assertRealAncestors(options.destination, options.staged.inventory.files, owned);
  // An existing entry at an incoming path is fine when it is the owned file itself (exact name, or
  // a case alias on case-insensitive filesystems) or a wholly owned directory whose files leave as
  // stale and whose emptied directories are pruned before the rename.
  const collisions: string[] = [];
  for (const file of options.staged.inventory.files) {
    if (owned.has(file)) continue;
    const target = join(options.destination, file);
    let metadata: Stats;
    try {
      metadata = await lstat(target);
    } catch (error) {
      // ENOTDIR: an owned file stands where the rebuild wants a directory; it leaves as stale first.
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) continue;
      throw error;
    }
    const tolerated = metadata.isDirectory() && !metadata.isSymbolicLink()
      ? await isWhollyOwnedDirectory(options.destination, file, owned, ownedDirectories)
      : metadata.isFile() && await isOwnedEntry(options.destination, owned, file);
    if (!tolerated) collisions.push(file);
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
  const pruned = await pruneEmptyDirectories(options.destination, stale, ownedDirectories);
  const created = new Set<string>();
  for (const file of options.staged.inventory.files) {
    await ensureAncestors(options.destination, file, created);
    await rename(join(options.staged.root, file), join(options.destination, file));
  }
  // The receipt owns what the installer owns now: the surviving directories it created before plus
  // the ones this replacement created. It is finalised in the private staging copy, then committed.
  const directories = sortNames([...new Set([
    ...[...ownedDirectories].filter((directory) => !pruned.has(directory)),
    ...created,
  ])]);
  await writeFile(
    join(options.staged.root, installReceiptFile),
    receiptDocument(createInstallReceipt({ ...options.receipt, directories, inventory: options.staged.inventory })),
    'utf8',
  );
  await rename(join(options.staged.root, installReceiptFile), join(options.destination, installReceiptFile));
};
