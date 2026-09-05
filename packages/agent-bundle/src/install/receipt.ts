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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/**
 * Current receipt format. Format 2 (#101) adds the lifecycle fields —
 * `mode`, `scope`, `registrations`, `hostDirectories`, `updatedAt` — that
 * `agent-bundle uninstall` consumes; format 1 receipts (#420) are read with
 * those fields synthesized (`migratedFrom` names the downgrade) and are
 * rewritten as format 2 by the next replacement.
 */
export const installReceiptFormat = 'agent-bundle-install-receipt/2';

export const legacyInstallReceiptFormat = 'agent-bundle-install-receipt/1';

/**
 * How the install was delivered: `local` copies into a host-loaded directory
 * (Cursor `plugins/local`), `marketplace` stages a local marketplace repository
 * (Cursor Customize import), `host-cli` registered through the host's own
 * plugin CLI (Claude, Codex).
 */
export type InstallReceiptMode = 'host-cli' | 'local' | 'marketplace';

export type InstallReceiptScope = 'local' | 'project' | 'user';

/**
 * One host registration the installer performed, recorded so uninstall
 * reverses exactly that and nothing else.
 */
export type InstallRegistrationKind =
  | 'claude-marketplace'
  | 'claude-plugin'
  | 'codex-marketplace'
  | 'codex-plugin'
  | 'cursor-local-plugin'
  | 'cursor-marketplace-staging';

export const installRegistrationKinds: readonly InstallRegistrationKind[] = Object.freeze([
  'claude-marketplace',
  'claude-plugin',
  'codex-marketplace',
  'codex-plugin',
  'cursor-local-plugin',
  'cursor-marketplace-staging',
]);

export interface InstallRegistration {
  /** Staged marketplace HEAD commit (`cursor-marketplace-staging`). */
  readonly commit?: string;
  /** `<plugin>@<marketplace>` for plugin registrations. */
  readonly id?: string;
  readonly kind: InstallRegistrationKind;
  /** Marketplace name for marketplace registrations. */
  readonly name?: string;
  /** Claude only: the scope the registration was made at. */
  readonly scope?: InstallReceiptScope;
}

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

/**
 * Recorded by the emitted `install.mjs` when it installs an Agent Plugins
 * pack into `~/.cursor/plugins/local`: Cursor 3.18.25 expands none of the
 * Agent Plugins placeholders, so the installer rewrites `mcp.json` in the
 * Cursor copy and keeps the pre-expansion document here for Doctor.
 */
export interface InstallReceiptCursorExpansion {
  /** Pre-expansion document text by plugin-relative path (`mcp.json`). */
  readonly documents: Readonly<Record<string, string>>;
  /** Absolute directory substituted for `${PLUGIN_DATA}` and exported as `PLUGIN_DATA`. */
  readonly pluginData: string;
  /** Absolute plugin root substituted for `${PLUGIN_ROOT}` and exported as `PLUGIN_ROOT`. */
  readonly pluginRoot: string;
}

export type InstallReceiptStateUnownedReason = 'foreign-marker' | 'pre-existing' | 'unproven';

export interface InstallReceiptStateOwner {
  readonly host: string;
  readonly id: string;
  readonly mode: InstallReceiptMode;
  readonly plugin: string;
  readonly projectRoot?: string;
  readonly scope: InstallReceiptScope;
}

export interface InstallReceiptStateRoot {
  readonly canonicalRoot: string;
  readonly ownership:
    | { readonly kind: 'derived' }
    | { readonly kind: 'marker'; readonly marker: string }
    | { readonly kind: 'unowned'; readonly reason: InstallReceiptStateUnownedReason };
  readonly root: string;
  readonly servers: readonly string[];
  readonly source: 'declared' | 'derived';
}

export interface InstallReceiptState {
  readonly owner: InstallReceiptStateOwner;
  readonly roots: readonly InstallReceiptStateRoot[];
}

export interface InstallReceipt {
  readonly contentHash: string;
  readonly cursorExpansion?: InstallReceiptCursorExpansion;
  /**
   * Directories the installer created (POSIX-relative, sorted). Only these
   * are ever pruned when they empty out; a directory that existed before the
   * installer wrote beneath it belongs to whoever made it.
   */
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly format: typeof installReceiptFormat;
  readonly host: string;
  /**
   * Directories the installer created under the host root (`~/.cursor`) on the
   * way to the plugin root (POSIX-relative to the host root, sorted), such as
   * `plugins` and `plugins/local` in a fresh Cursor home. Uninstall prunes
   * exactly these once they are empty and never a directory the host made.
   */
  readonly hostDirectories: readonly string[];
  readonly installedAt: string;
  /**
   * Present only on a receipt read from disk that predates the current
   * format: names the format it was read as, and every lifecycle field was
   * synthesized (best-effort defaults). Never written.
   */
  readonly migratedFrom?: string;
  readonly mode: InstallReceiptMode;
  readonly plugin: string;
  /**
   * Claude `project` / `local` scope only: the working directory whose
   * `.claude/settings*.json` holds the registration (the cwd the host verbs ran
   * in). Two projects installing the same plugin at the same scope are two
   * installs with two receipts, keyed by this root.
   */
  readonly projectRoot?: string;
  /** Host registrations the installer performed, in the order it performed them. */
  readonly registrations: readonly InstallRegistration[];
  readonly scope: InstallReceiptScope;
  /** Per-server runtime locations and the independent evidence authorizing deletion. */
  readonly state?: InstallReceiptState;
  /** Effective framework state root retained by a Cursor `--keep-data` uninstall. */
  readonly stateRoot?: {
    readonly root: string;
    readonly source: 'derived' | 'native';
  };
  /** When this receipt was last written (install or replacement); `installedAt` is the first install. */
  readonly updatedAt: string;
  readonly version: string;
  /** Derived web-data root retained by a Cursor `--keep-data` uninstall. */
  readonly webDataRoot?: string;
}

/** The lifecycle identity every receipt writer supplies; inventory and timestamps come from the write. */
export interface InstallReceiptIdentity {
  readonly host: string;
  readonly hostDirectories?: readonly string[];
  readonly installedAt?: string;
  readonly mode: InstallReceiptMode;
  readonly plugin: string;
  readonly projectRoot?: string;
  readonly registrations: readonly InstallRegistration[];
  readonly scope: InstallReceiptScope;
  readonly updatedAt?: string;
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
export const assertRealAncestors = async (
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
 * characters, alternate-stream colons, trailing dots or spaces) or resolve as
 * a DOS device (`NUL`, `CON.txt`, `COM1`, `LPT1.json`, ...).
 */
const windowsDeviceName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;

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
    !windowsDeviceName.test(segment) &&
    [...segment].every((character) => character.charCodeAt(0) >= 0x20) &&
    !segment.endsWith('.') &&
    !segment.endsWith(' '));

const isReceiptFileList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isReceiptPath);

/** A malformed expansion record reads as absent; the receipt itself stays valid. */
const readCursorExpansion = (value: unknown): InstallReceiptCursorExpansion | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const documents = record['documents'];
  if (
    typeof record['pluginRoot'] !== 'string' || record['pluginRoot'].length === 0 ||
    typeof record['pluginData'] !== 'string' || record['pluginData'].length === 0 ||
    documents === null || typeof documents !== 'object' || Array.isArray(documents) ||
    !Object.entries(documents as Record<string, unknown>).every(([path, text]) => isReceiptPath(path) && typeof text === 'string')
  ) {
    return undefined;
  }
  return Object.freeze({
    documents: Object.freeze({ ...(documents as Record<string, string>) }),
    pluginData: record['pluginData'],
    pluginRoot: record['pluginRoot'],
  });
};

const isReceiptScope = (value: unknown): value is InstallReceiptScope =>
  value === 'local' || value === 'project' || value === 'user';

const isReceiptMode = (value: unknown): value is InstallReceiptMode =>
  value === 'host-cli' || value === 'local' || value === 'marketplace';

const isRegistrationKind = (value: unknown): value is InstallRegistrationKind =>
  typeof value === 'string' && (installRegistrationKinds as readonly string[]).includes(value);

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const readReceiptState = (value: unknown): InstallReceiptState | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ownerValue = record['owner'];
  if (ownerValue === null || typeof ownerValue !== 'object' || Array.isArray(ownerValue)) return undefined;
  const owner = ownerValue as Record<string, unknown>;
  if (
    typeof owner['host'] !== 'string' ||
    typeof owner['id'] !== 'string' ||
    owner['id'].length === 0 ||
    !isReceiptMode(owner['mode']) ||
    typeof owner['plugin'] !== 'string' ||
    !optionalString(owner['projectRoot']) ||
    !isReceiptScope(owner['scope']) ||
    !Array.isArray(record['roots'])
  ) {
    return undefined;
  }
  const roots: InstallReceiptStateRoot[] = [];
  for (const valueRoot of record['roots']) {
    if (valueRoot === null || typeof valueRoot !== 'object' || Array.isArray(valueRoot)) return undefined;
    const root = valueRoot as Record<string, unknown>;
    const ownershipValue = root['ownership'];
    if (
      typeof root['canonicalRoot'] !== 'string' ||
      !isAbsolute(root['canonicalRoot']) ||
      typeof root['root'] !== 'string' ||
      !isAbsolute(root['root']) ||
      !Array.isArray(root['servers']) ||
      !root['servers'].every((server) => typeof server === 'string') ||
      (root['source'] !== 'declared' && root['source'] !== 'derived') ||
      ownershipValue === null ||
      typeof ownershipValue !== 'object' ||
      Array.isArray(ownershipValue)
    ) {
      return undefined;
    }
    const ownershipRecord = ownershipValue as Record<string, unknown>;
    const ownership = ownershipRecord['kind'] === 'derived'
      ? Object.freeze({ kind: 'derived' as const })
      : ownershipRecord['kind'] === 'marker' &&
          typeof ownershipRecord['marker'] === 'string' &&
          ownershipRecord['marker'] === join(root['root'], '.agent-bundle-state-owner.json')
        ? Object.freeze({ kind: 'marker' as const, marker: ownershipRecord['marker'] })
        : ownershipRecord['kind'] === 'unowned' &&
            (ownershipRecord['reason'] === 'foreign-marker' ||
              ownershipRecord['reason'] === 'pre-existing' ||
              ownershipRecord['reason'] === 'unproven')
          ? Object.freeze({ kind: 'unowned' as const, reason: ownershipRecord['reason'] })
          : undefined;
    if (ownership === undefined) return undefined;
    roots.push(Object.freeze({
      canonicalRoot: root['canonicalRoot'],
      ownership,
      root: root['root'],
      servers: Object.freeze([...root['servers']]),
      source: root['source'],
    }));
  }
  return Object.freeze({
    owner: Object.freeze({
      host: owner['host'],
      id: owner['id'],
      mode: owner['mode'],
      plugin: owner['plugin'],
      ...(owner['projectRoot'] === undefined ? {} : { projectRoot: owner['projectRoot'] }),
      scope: owner['scope'],
    }),
    roots: Object.freeze(roots),
  });
};

const readRegistration = (value: unknown): InstallRegistration | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isRegistrationKind(record['kind']) ||
    !optionalString(record['commit']) ||
    !optionalString(record['id']) ||
    !optionalString(record['name']) ||
    (record['scope'] !== undefined && !isReceiptScope(record['scope']))
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(record['commit'] === undefined ? {} : { commit: record['commit'] }),
    ...(record['id'] === undefined ? {} : { id: record['id'] }),
    kind: record['kind'],
    ...(record['name'] === undefined ? {} : { name: record['name'] }),
    ...(record['scope'] === undefined ? {} : { scope: record['scope'] }),
  });
};

/**
 * Validates a parsed receipt document. Format 1 receipts (written by #420
 * for Cursor local copies) are upgraded in memory: `mode: 'local'`,
 * `scope: 'user'`, a single `cursor-local-plugin` registration, no host
 * directories, and `updatedAt = installedAt`; `migratedFrom` records the
 * downgrade so Doctor can diagnose it. Any other format, or a current-format
 * receipt missing a field, reads as absent.
 */
const receiptFromDocument = (value: unknown): InstallReceipt | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const format = record['format'];
  if (format !== installReceiptFormat && format !== legacyInstallReceiptFormat) return undefined;
  if (
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
  const cursorExpansion = readCursorExpansion(record['cursorExpansion']);
  const state = readReceiptState(record['state']);
  if (record['state'] !== undefined && state === undefined) return undefined;
  const stateRootRecord = record['stateRoot'];
  const stateRoot = stateRootRecord !== undefined &&
    stateRootRecord !== null &&
    typeof stateRootRecord === 'object' &&
    !Array.isArray(stateRootRecord) &&
    typeof (stateRootRecord as Record<string, unknown>)['root'] === 'string' &&
    ((stateRootRecord as Record<string, unknown>)['source'] === 'derived' ||
      (stateRootRecord as Record<string, unknown>)['source'] === 'native')
    ? Object.freeze({
        root: (stateRootRecord as Record<string, unknown>)['root'] as string,
        source: (stateRootRecord as Record<string, unknown>)['source'] as 'derived' | 'native',
      })
    : undefined;
  const base = {
    contentHash: record['contentHash'],
    ...(cursorExpansion === undefined ? {} : { cursorExpansion }),
    directories: Object.freeze([...record['directories']]),
    files: Object.freeze([...record['files']]),
    format: installReceiptFormat,
    host: record['host'],
    installedAt: record['installedAt'],
    plugin: record['plugin'],
    ...(stateRoot === undefined ? {} : { stateRoot }),
    version: record['version'],
    ...(typeof record['webDataRoot'] === 'string' ? { webDataRoot: record['webDataRoot'] } : {}),
  } as const;
  if (format === legacyInstallReceiptFormat) {
    return Object.freeze({
      ...base,
      hostDirectories: Object.freeze([]),
      migratedFrom: legacyInstallReceiptFormat,
      mode: 'local',
      registrations: Object.freeze([Object.freeze({ kind: 'cursor-local-plugin' as const })]),
      scope: 'user',
      updatedAt: record['installedAt'],
    });
  }
  if (
    !isReceiptMode(record['mode']) ||
    !isReceiptScope(record['scope']) ||
    typeof record['updatedAt'] !== 'string' ||
    !isReceiptFileList(record['hostDirectories']) ||
    !Array.isArray(record['registrations'])
  ) {
    return undefined;
  }
  const registrations: InstallRegistration[] = [];
  for (const entry of record['registrations']) {
    const registration = readRegistration(entry);
    if (registration === undefined) return undefined;
    registrations.push(registration);
  }
  const ownedState = state !== undefined &&
    state.owner.host === record['host'] &&
    state.owner.mode === record['mode'] &&
    state.owner.plugin === record['plugin'] &&
    state.owner.scope === record['scope'] &&
    state.owner.projectRoot === record['projectRoot']
    ? state
    : undefined;
  return Object.freeze({
    ...base,
    hostDirectories: Object.freeze([...record['hostDirectories']]),
    mode: record['mode'],
    ...(typeof record['projectRoot'] === 'string' ? { projectRoot: record['projectRoot'] } : {}),
    registrations: Object.freeze(registrations),
    scope: record['scope'],
    ...(ownedState === undefined ? {} : { state: ownedState }),
    updatedAt: record['updatedAt'],
  });
};

/**
 * Reads a receipt file; malformed or unsafe receipts read as absent. A receipt
 * that is not a regular file (a symbolic link, a FIFO, a device) is refused
 * outright before it is read: it would let another file supply the owned-file
 * list that drives deletions, or block the read.
 */
export const readInstallReceiptFile = async (path: string): Promise<InstallReceipt | undefined> => {
  let value: unknown;
  try {
    if (!(await lstat(path)).isFile()) throw unsupportedEntry(basename(path));
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
  return receiptFromDocument(value);
};

/** Reads the receipt at a plugin root (`.agent-bundle-install.json`). */
export const readInstallReceipt = (destination: string): Promise<InstallReceipt | undefined> =>
  readInstallReceiptFile(join(destination, installReceiptFile));

/**
 * Builds a receipt for an inventory. `directories` defaults to every ancestor
 * of the inventoried files — right for a fresh install, where the installer
 * created all of them; callers that adopt or replace an existing tree pass
 * exactly the directories they created.
 */
export const createInstallReceipt = (options: InstallReceiptIdentity & {
  readonly cursorExpansion?: InstallReceiptCursorExpansion;
  readonly directories?: readonly string[];
  readonly inventory: TreeInventory;
  readonly state?: InstallReceiptState;
  readonly stateRoot?: InstallReceipt['stateRoot'];
  readonly webDataRoot?: string;
}): InstallReceipt => {
  const installedAt = options.installedAt ?? new Date().toISOString();
  return Object.freeze({
    contentHash: options.inventory.hash,
    ...(options.cursorExpansion === undefined ? {} : { cursorExpansion: options.cursorExpansion }),
    directories: options.directories ?? directoriesOf(options.inventory.files),
    files: options.inventory.files,
    format: installReceiptFormat,
    host: options.host,
    hostDirectories: Object.freeze(sortNames(options.hostDirectories ?? [])),
    installedAt,
    mode: options.mode,
    plugin: options.plugin,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    registrations: Object.freeze(options.registrations.map((registration) => Object.freeze({ ...registration }))),
    scope: options.scope,
    ...(options.state === undefined
      ? {}
      : {
          state: Object.freeze({
            owner: Object.freeze({ ...options.state.owner }),
            roots: Object.freeze(options.state.roots.map((root) => Object.freeze({
              ...root,
              ownership: Object.freeze({ ...root.ownership }),
              servers: Object.freeze([...root.servers]),
            }))),
          }),
        }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: Object.freeze({ ...options.stateRoot }) }),
    updatedAt: options.updatedAt ?? installedAt,
    version: options.version,
    ...(options.webDataRoot === undefined ? {} : { webDataRoot: options.webDataRoot }),
  });
};

/** The on-disk document: `migratedFrom` is a read-time annotation and is never persisted. */
const receiptDocument = (receipt: InstallReceipt): string => {
  const { migratedFrom: _migratedFrom, ...persisted } = receipt;
  return `${stableJson({ ...persisted, format: installReceiptFormat })}\n`;
};

/**
 * Writes a receipt document atomically at `path`: an exclusively created,
 * randomly named sibling (`wx` never follows an existing link or overwrites
 * a file) renamed into place.
 */
export const writeInstallReceiptFile = async (path: string, receipt: InstallReceipt): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(receiptDocument(receipt), 'utf8');
    await handle.close();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Lands a receipt at a plugin root atomically. */
export const writeInstallReceipt = (destination: string, receipt: InstallReceipt): Promise<void> =>
  writeInstallReceiptFile(join(destination, installReceiptFile), receipt);

/**
 * Agent Bundle-owned receipt store under a host root (`~/.claude`,
 * `~/.codex`, `~/.cursor`) for installs whose plugin tree is host-owned
 * (Claude and Codex cache copies) or is a staged marketplace repository
 * (Cursor `--mode marketplace`), where a receipt cannot live inside the tree.
 * Never inside the host's own `plugins/` directories.
 */
export const installReceiptStoreDirectory = (hostRoot: string): string => join(hostRoot, 'agent-bundle', 'receipts');

/** One receipt per plugin and delivery key (`<scope>` for host CLIs, `marketplace` for Cursor staging). */
export const installReceiptStorePath = (hostRoot: string, plugin: string, key: string): string =>
  join(installReceiptStoreDirectory(hostRoot), `${plugin}.${key}.json`);

/**
 * The delivery key for a host-CLI receipt: the scope alone for `user`, and
 * the scope plus a digest of the project root for `project` / `local`, whose
 * registrations live in that project's own `.claude/settings*.json`.
 */
export const installReceiptScopeKey = (scope: string, projectRoot: string | undefined): string =>
  scope === 'user' || projectRoot === undefined
    ? scope
    : `${scope}.${createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)}`;

/** Writes a store receipt, creating the store directories as needed. */
export const writeStoredInstallReceipt = async (path: string, receipt: InstallReceipt): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeInstallReceiptFile(path, receipt);
};

export interface StoredInstallReceipt {
  readonly path: string;
  readonly receipt: InstallReceipt;
}

export interface StoredInstallReceiptListing {
  /** Every readable receipt in the store, sorted by path. */
  readonly receipts: readonly StoredInstallReceipt[];
  /**
   * Store entries that exist but could not be read or parsed as receipts (and
   * the store directory itself when it exists but cannot be listed). A caller
   * deciding whether another install still depends on something must treat a
   * non-empty list as "unknown", never as "no dependents".
   */
  readonly unreadable: readonly string[];
}

/** Lists a host root's receipt store. A missing store is an empty listing; unreadable entries are reported, not thrown. */
export const listStoredInstallReceipts = async (hostRoot: string): Promise<StoredInstallReceiptListing> => {
  const directory = installReceiptStoreDirectory(hostRoot);
  let entries: readonly string[];
  try {
    entries = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      return Object.freeze({ receipts: Object.freeze([]), unreadable: Object.freeze([]) });
    }
    return Object.freeze({ receipts: Object.freeze([]), unreadable: Object.freeze([directory]) });
  }
  const receipts: StoredInstallReceipt[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(directory, entry);
    let receipt: InstallReceipt | undefined;
    try {
      receipt = await readInstallReceiptFile(path);
    } catch {
      unreadable.push(path);
      continue;
    }
    if (receipt === undefined) unreadable.push(path);
    else receipts.push(Object.freeze({ path, receipt }));
  }
  return Object.freeze({ receipts: Object.freeze(receipts), unreadable: Object.freeze(unreadable) });
};

const rmdirIfEmpty = async (path: string): Promise<boolean> => {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOTEMPTY') || isErrno(error, 'ENOENT') || isErrno(error, 'EEXIST') || isErrno(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
};

/**
 * Removes a store receipt and prunes the Agent Bundle-owned store directories
 * (`agent-bundle/receipts`, then `agent-bundle`) once they are empty. Returns
 * the paths actually removed.
 */
export const removeStoredInstallReceipt = async (path: string, hostRoot: string): Promise<readonly string[]> => {
  const removed: string[] = [];
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw unsupportedEntry(basename(path));
    await rm(path);
    removed.push(path);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  for (const directory of [installReceiptStoreDirectory(hostRoot), join(hostRoot, 'agent-bundle')]) {
    if (await rmdirIfEmpty(directory)) removed.push(directory);
  }
  return Object.freeze(removed);
};

/**
 * What `removeStoredInstallReceipt` would remove, without touching anything:
 * the receipt file when it exists, then each store directory whose every
 * remaining entry is itself gone. `--plan` reports exactly this set so the
 * plan and the completed result name the same paths.
 */
export const simulateRemoveStoredInstallReceipt = async (path: string, hostRoot: string): Promise<readonly string[]> => {
  const gone = new Set<string>();
  const removed: string[] = [];
  try {
    if ((await lstat(path)).isFile()) {
      gone.add(path);
      removed.push(path);
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  for (const directory of [installReceiptStoreDirectory(hostRoot), join(hostRoot, 'agent-bundle')]) {
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) continue;
      throw error;
    }
    if (entries.every((entry) => gone.has(join(directory, entry)))) {
      gone.add(directory);
      removed.push(directory);
    }
  }
  return Object.freeze(removed);
};

/** Removes an empty directory; reports whether it was removed (non-empty or absent directories are left alone). */
export const pruneEmptyDirectory = rmdirIfEmpty;

/**
 * A destination that holds nothing but runtime roots (`state/`) — and at most
 * a remnant receipt — is what `uninstall --keep-data` leaves behind: not a
 * foreign directory, but an empty shell around preserved durable state that a
 * reinstall fills back in.
 */
export const isRuntimeStateRemnant = async (destination: string): Promise<boolean> => {
  const entries = (await readdir(destination)).filter((name) => name !== installReceiptFile);
  return entries.length > 0 && entries.every(isPreservedRuntimeRoot);
};

/**
 * A remnant receipt owns no files and records no registrations: `uninstall`
 * writes it when the plugin root survives (retained runtime state or unowned
 * entries) so the host directories the install created stay receipt-owned for
 * a later purge and Doctor can explain the directory instead of calling it
 * corrupt.
 */
export const isRemnantReceipt = (receipt: InstallReceipt): boolean =>
  receipt.files.length === 0 && receipt.registrations.length === 0;

/** `sha256` of an empty owned set: what `hashOwnedFiles(root, [])` yields, and what a remnant receipt records. */
export const emptyContentHash = createHash('sha256').digest('hex');

export const hasInstallSurfaceMarkers = async (destination: string): Promise<boolean> => {
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
  readonly receipt: InstallReceiptIdentity;
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
  readonly receipt: InstallReceiptIdentity;
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
  // The first install time and the host directories the first install created carry over from the
  // previous receipt; `updatedAt` is this replacement.
  const directories = sortNames([...new Set([
    ...[...ownedDirectories].filter((directory) => !pruned.has(directory)),
    ...created,
  ])]);
  const previous = options.comparison.receipt;
  const now = new Date().toISOString();
  await writeFile(
    join(options.staged.root, installReceiptFile),
    receiptDocument(createInstallReceipt({
      ...options.receipt,
      directories,
      hostDirectories: options.receipt.hostDirectories ?? previous?.hostDirectories ?? [],
      installedAt: options.receipt.installedAt ?? previous?.installedAt ?? now,
      inventory: options.staged.inventory,
      updatedAt: options.receipt.updatedAt ?? now,
    })),
    'utf8',
  );
  await rename(join(options.staged.root, installReceiptFile), join(options.destination, installReceiptFile));
};
