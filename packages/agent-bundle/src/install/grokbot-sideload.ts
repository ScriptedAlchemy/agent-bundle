import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { Predicate } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { findGrokBotAgentData, listDirectory, pluginCacheKey, readJsonFile } from './grokbot-agent-data.ts';
import { type InstallReceiptGrokBotSideload, type TreeInventory, copyInventoryFiles } from './receipt.ts';

/**
 * Sideload for `install grokbot`: mirrors the Cursor projection into the plugin directories Grok Bot itself
 * manages, under `<agent-data>/plugins/`:
 *
 * - `marketplaces/github.com/<owner>/<repo>/<sha>/<plugin>/` — the plugin folder inside Grok Bot's (sparse,
 *   shallow) clone of the marketplace repository, beside the plugins Grok Bot materialized there, plus a
 *   `plugins` entry in that clone's `.cursor-plugin/marketplace.json` (or `.claude-plugin/marketplace.json`).
 * - `cache/<slug>/<plugin>/<sha>/` — a per-plugin cache copy with the `.cache-complete` marker Grok Bot's
 *   cache manager checks before it reuses a copy instead of cloning one.
 *
 * `<sha>` is never invented: it is the clone folder Grok Bot already has (the one its other plugins' cache
 * copies use while a re-clone briefly leaves two). Every folder carries `.agent-bundle-sideload.json` naming
 * the plugin, and the receipt records the exact manifest entry written: a folder without the marker, an entry
 * that differs from the recorded one, or a path reached through a symbolic link is Grok Bot's or another
 * plugin's and is never touched.
 *
 * What Grok Bot's plugin sync (startup, sign-in change, and every 24 hours) does to these paths, as read from
 * its host: it loads only the plugins the account's plugin listing returns, and after each pass removes every
 * `cache/<slug>/<plugin>` folder the listing did not name. A sideloaded cache copy therefore lasts until the
 * next pass unless the account lists `<plugin>` from `<slug>` at `<sha>`, in which case Grok Bot finds the
 * marked copy and loads it as is. The clone folder and manifest entry are untracked by git and survive passes
 * and sparse-checkout widening, until the marketplace moves to a new commit: Grok Bot then clones the new
 * `<sha>` and deletes every sibling clone folder, sideload included. Re-running the installer restores both.
 */

export const grokBotSideloadMarkerFile = '.agent-bundle-sideload.json';
export const defaultGrokBotSideloadRepo = 'scriptedalchemy/plugins';

const cacheCompleteFile = '.cache-complete';
/** Grok Bot reads the Cursor manifest first and falls back to the Claude one. */
const marketplaceManifestPaths = ['.cursor-plugin/marketplace.json', '.claude-plugin/marketplace.json'] as const;
const markerFormat = 'agent-bundle-grokbot-sideload@1';
const commitPattern = /^[0-9a-f]{40}$/u;
const repoSegmentPattern = /^[a-z0-9_.-]+$/u;
/** Grok Bot replaces anything else in cache slugs and plugin ids with `_`, so only these spell a stable path. */
const cacheSegmentPattern = /^[A-Za-z0-9_-]+$/u;

export interface GrokBotSideloadOptions {
  /** `false` skips the sideload (`--no-sideload`); defaults to on unless `GROK_BOT_SIDELOAD=0`. */
  readonly sideload?: boolean;
  /** `<owner>/<repo>` of the marketplace clone (`--sideload-repo`, `GROK_BOT_SIDELOAD_REPO`). */
  readonly sideloadRepo?: string;
  /** Grok Bot's cache partition for it (`--sideload-slug`, `GROK_BOT_SIDELOAD_SLUG`); defaults to `<owner>-<repo>`. */
  readonly sideloadSlug?: string;
}

export interface GrokBotSideloadSettings {
  readonly enabled: boolean;
  readonly repo: string;
  readonly slug: string;
}

export type GrokBotSideloadResult =
  | Readonly<{ readonly reason: string; readonly state: 'skipped' }>
  | Readonly<InstallReceiptGrokBotSideload & { readonly state: 'unchanged' | 'written' }>;

const failure = (message: string): DiagnosticError =>
  new DiagnosticError([{ code: 'AB7003', message, severity: 'error', target: 'grokbot' }]);

const disabledValues = new Set(['0', 'false', 'no', 'off']);

export const resolveGrokBotSideloadSettings = (
  options: GrokBotSideloadOptions,
  environment: Readonly<NodeJS.ProcessEnv>,
): GrokBotSideloadSettings => {
  const repo = (options.sideloadRepo ?? environment['GROK_BOT_SIDELOAD_REPO'] ?? defaultGrokBotSideloadRepo)
    .trim().toLowerCase().replace(/^(?:https?:\/\/)?github\.com\//u, '').replace(/(?:\.git)?\/?$/u, '');
  const segments = repo.split('/');
  if (segments.length !== 2 || segments.some((segment) => !repoSegmentPattern.test(segment) || /^\.+$/u.test(segment))) {
    throw failure(`Sideload repository ${JSON.stringify(repo)} must be a GitHub <owner>/<repo>.`);
  }
  const slug = (options.sideloadSlug ?? environment['GROK_BOT_SIDELOAD_SLUG'] ?? segments.join('-')).trim();
  if (!cacheSegmentPattern.test(slug)) {
    throw failure(`Sideload slug ${JSON.stringify(slug)} may contain only letters, digits, "-", and "_".`);
  }
  const fromEnvironment = environment['GROK_BOT_SIDELOAD'];
  const enabled = options.sideload ?? !(fromEnvironment !== undefined && disabledValues.has(fromEnvironment.trim().toLowerCase()));
  return Object.freeze({ enabled, repo, slug });
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
};

/** True only for a real directory (not a link) whose marker names `plugin`: proof the sideload wrote it. */
export const ownsGrokBotSideloadPath = async (path: string, plugin: string): Promise<boolean> => {
  if (!(await isDirectory(path))) return false;
  const marker = await readJsonFile(join(path, grokBotSideloadMarkerFile));
  return Predicate.isObject(marker) && marker['format'] === markerFormat && marker['plugin'] === plugin;
};

const markerDocument = (plugin: string): string => `${JSON.stringify({ format: markerFormat, plugin }, null, 2)}\n`;

const isInside = (root: string, path: string): boolean => {
  const tail = relative(root, path);
  return tail !== '' && !tail.startsWith('..') && !isAbsolute(tail);
};

/** Ancestors of `path` strictly below `root` that do not exist yet, outermost first. */
const missingAncestors = async (root: string, path: string): Promise<readonly string[]> => {
  const missing: string[] = [];
  for (let current = dirname(path); isInside(root, current); current = dirname(current)) {
    if (await exists(current)) break;
    missing.unshift(current);
  }
  return missing;
};

/** The `<sha>` folder Grok Bot is using for the marketplace clone, or why there is none to use. */
const activeClone = async (options: {
  readonly agentData: string;
  readonly plugin: string;
  readonly repoRoot: string;
  readonly slug: string;
}): Promise<{ readonly commit: string } | { readonly reason: string }> => {
  const clones: string[] = [];
  for (const name of await listDirectory(options.repoRoot)) {
    if (commitPattern.test(name) && await exists(join(options.repoRoot, name, '.git'))) clones.push(name);
  }
  if (clones.length === 1) return { commit: clones[0] as string };
  if (clones.length === 0) {
    return {
      reason: `Grok Bot has no clone of this marketplace under ${options.repoRoot}; install any plugin from it in Grok Bot ` +
        'first, or pass --sideload-repo for the marketplace Grok Bot already cloned.',
    };
  }
  // A re-clone briefly leaves two folders before Grok Bot prunes the old one; its plugins' cache copies name the live one.
  const cacheRoot = join(options.agentData, 'plugins', 'cache', options.slug);
  const used = new Set<string>();
  for (const plugin of await listDirectory(cacheRoot)) {
    if (plugin === options.plugin) continue;
    for (const version of await listDirectory(join(cacheRoot, plugin))) {
      if (clones.includes(version) && await exists(join(cacheRoot, plugin, version, cacheCompleteFile))) used.add(version);
    }
  }
  const [only] = used;
  return used.size === 1 && only !== undefined
    ? { commit: only }
    : { reason: `Grok Bot has ${clones.length} clones under ${options.repoRoot} (${clones.join(', ')}) and none is clearly active; rerun once its plugin sync finishes.` };
};

interface ManifestDocument {
  readonly document: Record<string, unknown> & { readonly plugins: unknown[] };
  readonly path: string;
  readonly text: string;
}

const readManifest = async (path: string): Promise<ManifestDocument | undefined> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Predicate.isObject(document) || !Array.isArray(document['plugins'])) return undefined;
  return { document: document as ManifestDocument['document'], path, text };
};

const entryIndex = (manifest: ManifestDocument, plugin: string): number =>
  manifest.document.plugins.findIndex((entry) => Predicate.isObject(entry) && entry['name'] === plugin);

const sameEntry = (left: unknown, right: Readonly<Record<string, string>> | undefined): boolean => {
  if (!Predicate.isObject(left) || right === undefined) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, position) => key === rightKeys[position] && left[key] === right[key]);
};

const listedEntry = (manifest: ManifestDocument, plugin: string): unknown => manifest.document.plugins[entryIndex(manifest, plugin)];

/**
 * True when `path` resolves to itself below the real `agentData`: no symbolic link between the agent-data root
 * and `path` could redirect a removal or write somewhere the record does not name. A missing path is accepted.
 */
const resolvesInPlace = async (agentData: string, path: string): Promise<boolean> => {
  let root: string;
  try {
    root = await realpath(agentData);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
  const tail = relative(agentData, path);
  if (tail === '' || tail.startsWith('..') || isAbsolute(tail)) return false;
  // Walk down from the root: every existing component must resolve to exactly its own spelling.
  let expected = root;
  for (const segment of tail.split(sep)) {
    expected = join(expected, segment);
    let actual: string;
    try {
      actual = await realpath(expected);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return true;
      throw error;
    }
    if (actual !== expected) return false;
  }
  return true;
};

const indentOf = (text: string): string => /^\{\r?\n([ \t]+)"/u.exec(text)?.[1] ?? '  ';

/** Serializes `plugins` into `manifest`, keeping its other fields, indentation, and trailing newline. */
const manifestText = (manifest: ManifestDocument, plugins: readonly unknown[]): string =>
  `${JSON.stringify({ ...manifest.document, plugins }, null, indentOf(manifest.text))}${manifest.text.endsWith('\n') ? '\n' : ''}`;

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
};

const manifestAttempts = 5;

/**
 * Applies `update` to the manifest and replaces it atomically (exclusive temporary sibling, then rename), keeping
 * its mode and layout. Optimistic: the file is read again right before the rename and, when Grok Bot changed it
 * meanwhile, `update` runs again on the new contents, so a concurrent write is not overwritten with stale JSON
 * (only the instant between that last read and the rename is unguarded; Grok Bot takes no lock to share).
 * `update` returns the new `plugins` array, `undefined` to leave the file alone, or throws to refuse.
 */
const updateManifest = async (
  path: string,
  update: (manifest: ManifestDocument) => readonly unknown[] | undefined,
): Promise<boolean> => {
  for (let attempt = 0; attempt < manifestAttempts; attempt += 1) {
    const manifest = await readManifest(path);
    if (manifest === undefined) throw failure(`${path} is no longer a readable marketplace manifest; left untouched.`);
    const plugins = update(manifest);
    if (plugins === undefined) return false;
    const text = manifestText(manifest, plugins);
    if (text === manifest.text) return false;
    const mode = (await stat(path)).mode & 0o777;
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', mode);
      try {
        await handle.writeFile(text, 'utf8');
      } finally {
        await handle.close();
      }
      if (await readText(path) !== manifest.text) continue;
      await rename(temporary, path);
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  throw failure(`${path} kept changing while agent-bundle updated it; rerun once Grok Bot's plugin sync settles.`);
};

/** Scratch siblings `writeTree` names `.<basename>.agent-bundle-<uuid>[.replaced]`; only this installer makes them. */
const scratchPattern = (destination: string): RegExp => {
  const name = basename(destination).replace(/[$()*+.?[\\\]^{|}]/gu, (character) => `\\${character}`);
  return new RegExp(`^\\.${name}\\.agent-bundle-[0-9a-f-]{36}(?:\\.replaced)?$`, 'u');
};

/**
 * Clears what an interrupted `writeTree` left beside `destination`: half-written stages (only this installer names
 * them so) are deleted, and an aside copy is deleted only when it carries this plugin's marker. An unmarked aside
 * is someone else's folder caught mid-swap: it goes back to `destination` when that is free and is otherwise kept.
 */
const removeScratch = async (destination: string, plugin: string): Promise<void> => {
  const pattern = scratchPattern(destination);
  for (const name of await listDirectory(dirname(destination))) {
    if (!pattern.test(name)) continue;
    const path = join(dirname(destination), name);
    if (!name.endsWith('.replaced') || await ownsGrokBotSideloadPath(path, plugin)) {
      await rm(path, { force: true, recursive: true });
    } else if (!(await exists(destination))) {
      await rename(path, destination);
    }
  }
};

/**
 * Lands the plugin tree at `destination`: a fully written, marked sibling is renamed into place, so Grok Bot never
 * sees a half-copied folder (or a `.cache-complete` folder missing files). Replacing an earlier sideload copy is
 * two renames (the old copy aside, the new one in) with the old copy deleted at once; no portable rename swaps
 * directories, so an interrupted swap can leave the destination briefly absent, never partial, and its scratch
 * sibling is deleted by the next install or uninstall. Ownership is checked again on the copy actually moved aside:
 * a folder that appeared meanwhile without this plugin's marker is put back and the write fails.
 */
const writeTree = async (options: {
  readonly agentData: string;
  readonly artifact: TreeInventory;
  readonly bundleRoot: string;
  readonly cacheComplete: boolean;
  readonly destination: string;
  readonly plugin: string;
}): Promise<void> => {
  const { destination, plugin } = options;
  if (!(await resolvesInPlace(options.agentData, destination))) throw failure(`${destination} resolves through a symbolic link; sideload refused.`);
  await mkdir(dirname(destination), { recursive: true });
  await removeScratch(destination, plugin);
  const stage = join(dirname(destination), `.${basename(destination)}.agent-bundle-${randomUUID()}`);
  const aside = `${stage}.replaced`;
  const foreign = (): DiagnosticError =>
    failure(`${destination} appeared without agent-bundle's sideload marker while installing; left untouched.`);
  // Set only once the folder moved aside is proven to be this plugin's sideload: nothing else is ever deleted.
  let asideOwned = false;
  try {
    await copyInventoryFiles(options.bundleRoot, stage, options.artifact);
    await writeFile(join(stage, grokBotSideloadMarkerFile), markerDocument(plugin));
    if (options.cacheComplete) await writeFile(join(stage, cacheCompleteFile), '');
    if (await exists(destination)) {
      if (!(await ownsGrokBotSideloadPath(destination, plugin))) throw foreign();
      await rename(destination, aside);
      if (!(await ownsGrokBotSideloadPath(aside, plugin))) {
        await rename(aside, destination);
        throw foreign();
      }
      asideOwned = true;
      try {
        await rename(stage, destination);
      } catch (error) {
        await rename(aside, destination);
        throw error;
      }
    } else {
      await rename(stage, destination);
    }
  } finally {
    await rm(stage, { force: true, recursive: true });
    if (asideOwned) await rm(aside, { force: true, recursive: true });
  }
};

const isEmptyDirectory = async (path: string, removing: ReadonlySet<string>): Promise<boolean> =>
  await isDirectory(path) && (await listDirectory(path)).every((entry) => removing.has(join(path, entry)));

export interface GrokBotSideloadRemoval {
  /** Owned folders removed (or, with `plan`, that would be), then created parents left empty. */
  readonly directories: readonly string[];
  /** The manifest whose entry was (or would be) removed. */
  readonly manifest?: string;
  /** Recorded paths kept because they no longer carry this plugin's marker. */
  readonly retained: readonly string[];
}

/**
 * Removes what a sideload record names, and nothing else: folders that still carry this plugin's marker and resolve
 * in place below agent-data, the manifest entry while it still equals the recorded entry (and its plugin folder is
 * not someone else's), and created parents once empty. `keep` names paths a newer sideload reuses.
 */
export const removeGrokBotSideload = async (
  record: InstallReceiptGrokBotSideload,
  plugin: string,
  options: { readonly keep?: ReadonlySet<string>; readonly plan?: boolean } = {},
): Promise<GrokBotSideloadRemoval> => {
  const keep = options.keep ?? new Set<string>();
  const directories: string[] = [];
  const retained: string[] = [];
  let pluginFolderOurs = true;
  for (const path of [record.cachePath, record.pluginPath]) {
    if (keep.has(path)) continue;
    if (options.plan !== true && await resolvesInPlace(record.agentData, path)) await removeScratch(path, plugin);
    if (!(await exists(path))) continue;
    if (await ownsGrokBotSideloadPath(path, plugin) && await resolvesInPlace(record.agentData, path)) {
      if (options.plan !== true) await rm(path, { force: true, recursive: true });
      directories.push(path);
    } else {
      retained.push(path);
      if (path === record.pluginPath) pluginFolderOurs = false;
    }
  }
  let manifest: string | undefined;
  if (!keep.has(record.manifest) && pluginFolderOurs && await resolvesInPlace(record.agentData, record.manifest)) {
    const document = await readManifest(record.manifest);
    if (document !== undefined && sameEntry(listedEntry(document, plugin), record.entry)) {
      // Re-validated on every attempt, against the manifest as it is right before the rename.
      const removed = options.plan === true || await updateManifest(record.manifest, (latest) =>
        sameEntry(listedEntry(latest, plugin), record.entry)
          ? latest.document.plugins.filter((_, position) => position !== entryIndex(latest, plugin))
          : undefined);
      if (removed) manifest = record.manifest;
      else retained.push(record.manifest);
    } else if (document !== undefined && entryIndex(document, plugin) >= 0) {
      retained.push(record.manifest);
    }
  }
  const removing = new Set(directories);
  for (const directory of [...record.createdDirectories].reverse()) {
    if (keep.has(directory) || !(await resolvesInPlace(record.agentData, directory)) || !(await isEmptyDirectory(directory, removing))) continue;
    if (options.plan !== true) await rmdir(directory).catch(() => undefined);
    removing.add(directory);
    directories.push(directory);
  }
  return Object.freeze({
    directories: Object.freeze(directories),
    ...(manifest === undefined ? {} : { manifest }),
    retained: Object.freeze(retained),
  });
};

interface SideloadTarget extends InstallReceiptGrokBotSideload {
  readonly manifestDocument: ManifestDocument;
  /** Older sideload copies of this plugin in the same cache folder (from an earlier `<sha>`). */
  readonly stale: readonly string[];
}

export type GrokBotSideloadPlan =
  | Readonly<{ readonly reason: string; readonly state: 'skipped' }>
  | Readonly<{ readonly state: 'ready'; readonly target: SideloadTarget }>;

/** The manifest's `plugin` entry is exactly the one the previous sideload recorded writing there. */
const ownsManifestEntry = (
  manifest: ManifestDocument,
  plugin: string,
  previous: InstallReceiptGrokBotSideload | undefined,
): boolean => previous?.manifest === manifest.path && sameEntry(listedEntry(manifest, plugin), previous.entry);

const skipped = (reason: string): GrokBotSideloadPlan => Object.freeze({ reason, state: 'skipped' });

/**
 * Read-only: where the sideload would write, or why it is skipped. Skips (never fails) when this computer has no
 * Grok Bot data or clone of the marketplace, and when any target path or manifest entry belongs to someone else.
 */
export const planGrokBotSideload = async (options: {
  readonly description?: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  readonly plugin: string;
  readonly previous?: InstallReceiptGrokBotSideload;
  readonly settings: GrokBotSideloadSettings;
}): Promise<GrokBotSideloadPlan> => {
  const { plugin, previous, settings } = options;
  if (!settings.enabled) return skipped('disabled by --no-sideload or GROK_BOT_SIDELOAD.');
  if (!cacheSegmentPattern.test(plugin)) return skipped(`Grok Bot cache paths cannot spell the plugin name ${JSON.stringify(plugin)}.`);
  const agentData = await findGrokBotAgentData(options.environment, options.home);
  if (agentData === undefined) {
    return skipped('no Grok Bot agent-data on this computer (GROK_BOT_AGENT_DATA_DIR, /home/box/agent-data, ' +
      '~/.grokbot/agent-data, or ~/Library/Application Support/Grok Bot/agent-data).');
  }
  const [owner, repo] = settings.repo.split('/') as [string, string];
  const repoRoot = join(agentData, 'plugins', 'marketplaces', 'github.com', owner, repo);
  const active = await activeClone({ agentData, plugin, repoRoot, slug: settings.slug });
  if ('reason' in active) return skipped(active.reason);
  const clone = join(repoRoot, active.commit);
  let manifestDocument: ManifestDocument | undefined;
  for (const path of marketplaceManifestPaths) {
    manifestDocument = await readManifest(join(clone, path));
    if (manifestDocument !== undefined) break;
  }
  if (manifestDocument === undefined) return skipped(`the clone ${clone} has no readable marketplace manifest.`);
  const metadata = manifestDocument.document['metadata'];
  const pluginRoot = Predicate.isObject(metadata) && typeof metadata['pluginRoot'] === 'string' ? metadata['pluginRoot'] : '';
  const pluginPath = join(clone, pluginRoot, plugin);
  if (!isInside(clone, pluginPath) || relative(clone, pluginPath).split(sep).includes('.git')) {
    return skipped(`the manifest's pluginRoot ${JSON.stringify(pluginRoot)} leaves the clone ${clone}.`);
  }
  const ownsPluginPath = await ownsGrokBotSideloadPath(pluginPath, plugin);
  if (!ownsPluginPath && await exists(pluginPath)) {
    return skipped(`${pluginPath} already exists and was not written by agent-bundle (Grok Bot's copy or another plugin's); left untouched.`);
  }
  if (entryIndex(manifestDocument, plugin) >= 0 && !ownsManifestEntry(manifestDocument, plugin, previous)) {
    return skipped(`${manifestDocument.path} already lists a plugin named ${plugin} that agent-bundle did not add; left untouched.`);
  }
  const cacheRoot = join(agentData, 'plugins', 'cache');
  const cachePluginRoot = join(cacheRoot, settings.slug, plugin);
  const cachePath = join(cachePluginRoot, active.commit);
  for (const path of [manifestDocument.path, pluginPath, cachePath]) {
    if (!(await resolvesInPlace(agentData, path))) return skipped(`${path} resolves through a symbolic link; left untouched.`);
  }
  const stale: string[] = [];
  for (const version of await listDirectory(cachePluginRoot)) {
    const path = join(cachePluginRoot, version);
    if (version.startsWith('.')) continue;
    if (!(await ownsGrokBotSideloadPath(path, plugin))) {
      return skipped(`Grok Bot already has its own copy of ${plugin} at ${path} (an account install); the sideload would shadow it, ` +
        'so it was skipped.');
    }
    if (path !== cachePath) stale.push(path);
  }
  const keptCreated = (previous?.createdDirectories ?? []).filter((directory) =>
    isInside(directory, cachePath) || isInside(directory, pluginPath));
  const created = [...new Set([
    ...keptCreated,
    ...await missingAncestors(cacheRoot, cachePath),
    ...await missingAncestors(clone, pluginPath),
  ])];
  const entry: Readonly<Record<string, string>> = Object.freeze({
    name: plugin,
    source: plugin,
    ...(options.description === undefined ? {} : { description: options.description }),
  });
  return Object.freeze({
    state: 'ready' as const,
    target: Object.freeze({
      agentData,
      cachePath,
      commit: active.commit,
      createdDirectories: Object.freeze(created),
      entry,
      manifest: manifestDocument.path,
      manifestDocument,
      pluginPath,
      repo: settings.repo,
      slug: settings.slug,
      stale: Object.freeze(stale),
    }),
  });
};

export const grokBotSideloadRecord = (target: SideloadTarget): InstallReceiptGrokBotSideload => Object.freeze({
  agentData: target.agentData,
  cachePath: target.cachePath,
  commit: target.commit,
  createdDirectories: target.createdDirectories,
  entry: target.entry,
  manifest: target.manifest,
  pluginPath: target.pluginPath,
  repo: target.repo,
  slug: target.slug,
});

const sameLocation = (left: InstallReceiptGrokBotSideload, right: InstallReceiptGrokBotSideload): boolean =>
  left.cachePath === right.cachePath && left.pluginPath === right.pluginPath && left.manifest === right.manifest;

/**
 * Writes a ready plan: the cache copy (with `.cache-complete`), the clone folder, then the manifest entry.
 * `unchanged` when the previous sideload is already exactly this content at this location. `progress.started`
 * turns true before the first write, so a caller that fails afterwards knows to `rollbackGrokBotSideload`.
 * Superseded copies are left for `finishGrokBotSideload`, once the receipt names the new location.
 */
export const applyGrokBotSideload = async (options: {
  readonly artifact: TreeInventory;
  readonly bundleRoot: string;
  readonly plugin: string;
  readonly previous?: InstallReceiptGrokBotSideload;
  readonly previousContentHash?: string;
  readonly progress: { started: boolean };
  readonly target: SideloadTarget;
}): Promise<GrokBotSideloadResult> => {
  const { artifact, plugin, previous, target } = options;
  const record = grokBotSideloadRecord(target);
  // Re-read the manifest now: Grok Bot may have rewritten it since planning.
  const current = await currentManifest(target, plugin, previous);
  if (
    previous !== undefined &&
    sameLocation(previous, record) &&
    sameEntry(previous.entry, record.entry) &&
    options.previousContentHash === artifact.hash &&
    target.stale.length === 0 &&
    await ownsGrokBotSideloadPath(target.pluginPath, plugin) &&
    await ownsGrokBotSideloadPath(target.cachePath, plugin) &&
    await exists(join(target.cachePath, cacheCompleteFile)) &&
    sameEntry(listedEntry(current, plugin), record.entry)
  ) {
    return Object.freeze({ ...record, state: 'unchanged' });
  }
  options.progress.started = true;
  const write = { agentData: target.agentData, artifact, bundleRoot: options.bundleRoot, plugin };
  await writeTree({ ...write, cacheComplete: true, destination: target.cachePath });
  await writeTree({ ...write, cacheComplete: false, destination: target.pluginPath });
  // Validated again on every attempt against the manifest as it is right before the rename.
  await updateManifest(target.manifest, (latest) => {
    assertEntryOwnable(latest, target, plugin, previous);
    const plugins = [...latest.document.plugins];
    const listedAt = entryIndex(latest, plugin);
    if (listedAt >= 0) plugins[listedAt] = target.entry;
    else plugins.push(target.entry);
    return plugins;
  });
  return Object.freeze({ ...record, state: 'written' });
};

/** The target manifest as it is now, refusing when its `plugin` entry has become one agent-bundle did not write. */
const currentManifest = async (
  target: SideloadTarget,
  plugin: string,
  previous: InstallReceiptGrokBotSideload | undefined,
): Promise<ManifestDocument> => {
  if (!(await resolvesInPlace(target.agentData, target.manifest))) {
    throw failure(`${target.manifest} resolves through a symbolic link; sideload refused.`);
  }
  const manifest = await readManifest(target.manifest);
  if (manifest === undefined) throw failure(`${target.manifest} is no longer a readable marketplace manifest; sideload refused.`);
  assertEntryOwnable(manifest, target, plugin, previous);
  return manifest;
};

/** Refuses when the manifest's `plugin` entry is neither absent, the one about to be written, nor the recorded one. */
const assertEntryOwnable = (
  manifest: ManifestDocument,
  target: SideloadTarget,
  plugin: string,
  previous: InstallReceiptGrokBotSideload | undefined,
): void => {
  const listed = listedEntry(manifest, plugin);
  if (listed !== undefined && !sameEntry(listed, target.entry) && !ownsManifestEntry(manifest, plugin, previous)) {
    throw failure(`${target.manifest} gained a plugin named ${plugin} that agent-bundle did not add; left untouched.`);
  }
};

/**
 * After the receipt names the new sideload: deletes this plugin's older sideload copies (an earlier `<sha>`) and
 * whatever of the previous record the new one does not reuse.
 */
export const finishGrokBotSideload = async (options: {
  readonly plugin: string;
  readonly previous?: InstallReceiptGrokBotSideload;
  readonly target: SideloadTarget;
}): Promise<void> => {
  const { plugin, previous, target } = options;
  for (const path of target.stale) {
    if (await ownsGrokBotSideloadPath(path, plugin) && await resolvesInPlace(target.agentData, path)) {
      await rm(path, { force: true, recursive: true });
    }
  }
  const record = grokBotSideloadRecord(target);
  if (previous !== undefined && !sameLocation(previous, record)) {
    await removeGrokBotSideload(previous, plugin, {
      keep: new Set([record.cachePath, record.pluginPath, record.manifest, ...record.createdDirectories]),
    });
  }
};

/**
 * Undoes a failed `applyGrokBotSideload` before any receipt names it: removes the target's marked folders, its entry
 * (only while it is exactly the one written), and created parents, keeping whatever the previous record names at a
 * different location. Writing replaced any previous copy at the same location in place, and no copy is kept to put
 * back, so the previous receipt can then name absent paths: Doctor reports that and rerunning restores it.
 */
export const rollbackGrokBotSideload = async (options: {
  readonly plugin: string;
  readonly previous?: InstallReceiptGrokBotSideload;
  readonly target: SideloadTarget;
}): Promise<void> => {
  const { plugin, previous, target } = options;
  const record = grokBotSideloadRecord(target);
  const keep = previous === undefined || sameLocation(previous, record)
    ? new Set<string>()
    : new Set([previous.cachePath, previous.pluginPath, ...previous.createdDirectories]);
  await removeGrokBotSideload(record, plugin, { keep });
};

/** How a recorded sideload looks to Grok Bot right now (Doctor). */
export interface GrokBotSideloadInspection {
  readonly cacheCopy: boolean;
  readonly cloneActive: boolean;
  readonly listed: boolean;
  /** Grok Bot's plugin index names the cache copy: the account lists the plugin and Grok Bot loaded this copy. */
  readonly loaded: boolean;
  readonly pluginFolder: boolean;
}

export const inspectGrokBotSideload = async (
  record: InstallReceiptGrokBotSideload,
  plugin: string,
): Promise<GrokBotSideloadInspection> => {
  const index = await readJsonFile(join(record.agentData, 'plugin-skills', 'cache.json'));
  const key = pluginCacheKey(record.cachePath);
  const folders = Predicate.isObject(index) && Array.isArray(index['installFolders']) ? index['installFolders'] as unknown[] : [];
  const manifest = await readManifest(record.manifest);
  const [owner = '', repo = ''] = record.repo.split('/');
  return Object.freeze({
    cacheCopy: await ownsGrokBotSideloadPath(record.cachePath, plugin) && await exists(join(record.cachePath, cacheCompleteFile)),
    cloneActive: await exists(join(record.agentData, 'plugins', 'marketplaces', 'github.com', owner, repo, record.commit, '.git')),
    listed: manifest !== undefined && sameEntry(listedEntry(manifest, plugin), record.entry),
    loaded: key !== undefined && folders.some((folder) =>
      Predicate.isObject(folder) && typeof folder['installPath'] === 'string' && pluginCacheKey(folder['installPath']) === key),
    pluginFolder: await ownsGrokBotSideloadPath(record.pluginPath, plugin),
  });
};
