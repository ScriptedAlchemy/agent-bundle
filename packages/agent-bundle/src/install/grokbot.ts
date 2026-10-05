import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Predicate } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { errorMessage, isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { cursorMarketplaceRoot, stageCursorMarketplace } from './cursor-marketplace.ts';
import { bundleInventory, readBundleIdentity } from './identity.ts';
import {
  type InstallReceipt,
  type TreeInventory,
  copyInventoryFiles,
  createInstallReceipt,
  installReceiptStorePath,
  readInstallReceiptFile,
  writeStoredInstallReceipt,
} from './receipt.ts';
import type { InstallBundleOptions, InstallCommandRunner, InstallResult } from './install.ts';

/**
 * Grok Bot host (`install grokbot`).
 *
 * Grok Bot loads Cursor-format plugins (`.cursor-plugin/plugin.json` with
 * skills, rules, agents, commands, and `mcpServers`) that are installed into
 * the user's Cursor account from a Git marketplace (`.cursor-plugin/
 * marketplace.json`). Its computer clones each installed plugin into
 * `<agent-data>/plugins/cache/<marketplace>/<plugin>/<commit>/` (with an empty
 * `.cache-complete` marker) and records the server-assigned plugin id per
 * skill in `<agent-data>/plugin-skills/cache.json`. Observed 2026-09-29 on the
 * Grok Bot computer: registration is an account-level install through Grok
 * Bot's Marketplace UI, the in-chat InstallPlugin tool, or a
 * `grokbot://app/v1/plugin/add?id=<plugin id>` link, all keyed by that
 * server-assigned id. There is no local-folder import and no CLI verb, so the
 * installer stages a committed marketplace repository built from the Cursor
 * projection, records a receipt, prints the exact remaining steps, and (on a
 * Grok Bot computer) sideloads the plugin into a marketplace snapshot Grok Bot
 * already syncs; see `sideloadGrokBot` below.
 * Doctor reads the cache and skill index read-only to report the plugin id
 * and the commit Grok Bot installed.
 */

export const grokBotHost = 'grokbot';

/** Agent Bundle's own Grok Bot root: the marketplace staging repository and receipt store live under it. */
export const grokBotRoot = (options: { readonly environment?: Readonly<NodeJS.ProcessEnv>; readonly home?: string }): string =>
  (options.environment ?? process.env)['GROK_BOT_HOME'] ?? join(options.home ?? homedir(), '.grokbot');

export const grokBotMarketplaceRoot = (root: string): string => cursorMarketplaceRoot(root);

export const grokBotReceiptPath = (root: string, plugin: string): string =>
  installReceiptStorePath(root, plugin, 'marketplace');

export const grokBotNextSteps = (repoRoot: string, plugin: string, bin = 'agent-bundle'): readonly string[] => Object.freeze([
  `Push ${repoRoot} to a GitHub repository (or copy plugins/${plugin} and its .cursor-plugin/marketplace.json entry into a ` +
    'marketplace repository you already use): Grok Bot installs plugins only from hosted Git marketplaces, not local folders.',
  'Add that repository as a plugin marketplace on your Cursor account (Grok Bot reads the same account plugin catalog).',
  `In Grok Bot, open Marketplace -> Plugins and install "${plugin}" (or ask a Grok Bot agent to install it; ` +
    'grokbot://app/v1/plugin/add?id=<plugin id> opens the install card once the marketplace assigned the id).',
  `Verify on the Grok Bot computer with \`${bin} doctor --host grokbot\`: it reports the plugin id and installed commit ` +
    'once Grok Bot has cloned the plugin.',
]);

/**
 * The shared stager words its diagnostics for Cursor's `--mode marketplace`; the grokbot host has no `--mode`, so
 * recovery advice pointing at `--mode local` or Cursor would be wrong here.
 */
const grokBotStagingRewrites: readonly (readonly [string, string])[] = [
  ['; install git or use `--mode local`.', '; install git.'],
  [', or use `--mode local`.', '.'],
  [' Agent Plugins (root `plugin.json`) packs install with `--mode local`.', ' List `cursor` in the bundle targets.'],
  ['git is required for `--mode marketplace` (Cursor imports marketplaces from Git repositories)',
    'git is required for the grokbot host (Grok Bot installs plugins from Git marketplaces)'],
  ['`--mode marketplace` requires', 'The grokbot host requires'],
  ['`--mode marketplace` refuses', 'The grokbot host refuses'],
  ['Cursor marketplace staging', 'Grok Bot marketplace staging'],
  ['Cursor marketplaces resolve', 'Grok Bot marketplaces resolve'],
  ['Cursor would import', 'Grok Bot would import'],
];

export const grokBotStagingMessage = (message: string): string =>
  grokBotStagingRewrites.reduce((text, [from, to]) => text.split(from).join(to), message);

const failure = (code: string, message: string): DiagnosticError =>
  new DiagnosticError([{ code, message, severity: 'error', target: grokBotHost }]);

const gitOutput = async (runner: InstallCommandRunner, cwd: string, args: readonly string[]): Promise<string | undefined> => {
  const result = await runner.run('git', args, { cwd }).catch(() => undefined);
  return result === undefined || result.code !== 0 ? undefined : result.stdout.trim();
};

/**
 * Moves a receipt-owned staging repository aside when this install supersedes it: same-version content drift is
 * restaged automatically, a different version only with `--replace`. Ownership means the receipt names this plugin
 * and host and its commit is the clean HEAD; anything else is left for the stager to refuse (`AB7005`).
 * Returns the aside path so a failed restage can be rolled back.
 */
const supersedeOwnedStaging = async (options: {
  readonly artifact: { readonly hash: string };
  readonly identity: { readonly plugin: string; readonly version: string };
  readonly options: InstallBundleOptions;
  readonly previousReceipt: InstallReceipt | undefined;
  readonly repoRoot: string;
  readonly runner: InstallCommandRunner;
}): Promise<string | undefined> => {
  const { identity, previousReceipt, repoRoot, runner } = options;
  if (previousReceipt === undefined || !(await exists(repoRoot))) return undefined;
  const sameVersion = previousReceipt.version === identity.version;
  if (sameVersion && previousReceipt.contentHash === options.artifact.hash) return undefined;
  const commit = previousReceipt.registrations[0]?.commit;
  const owned = previousReceipt.host === grokBotHost &&
    previousReceipt.plugin === identity.plugin &&
    commit !== undefined &&
    await gitOutput(runner, repoRoot, ['rev-parse', 'HEAD']) === commit &&
    await gitOutput(runner, repoRoot, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']) === '';
  if (!owned) return undefined;
  if (!sameVersion && options.options.replace !== true) {
    throw failure(
      'AB7005',
      `Refusing version collision at ${repoRoot}: found ${previousReceipt.version}, requested ${identity.version}. ` +
        'Re-run with --replace to restage it.',
    );
  }
  const aside = join(repoRoot, '..', `.${identity.plugin}.superseded-${process.pid}-${Date.now()}`);
  await rename(repoRoot, aside);
  return aside;
};

/**
 * Stages the Cursor projection as a committed marketplace repository under
 * `<grokbot root>/agent-bundle/marketplaces/<plugin>` and writes a store
 * receipt beside it. Nothing is registered with Grok Bot: the plugin id is
 * assigned by the marketplace once the repository is hosted and installed.
 */
export const installGrokBot = async (
  options: InstallBundleOptions,
  runner: InstallCommandRunner,
  treeHash: (root: string) => Promise<string>,
): Promise<InstallResult> => {
  if ((options.scope ?? 'user') !== 'user') {
    throw failure('AB7003', `Grok Bot plugin installation supports only user scope, not ${options.scope ?? 'user'}.`);
  }
  if (options.mode !== undefined) {
    throw failure('AB7003', `Install mode ${JSON.stringify(options.mode)} applies to the cursor host only.`);
  }
  const identity = await readBundleIdentity(options.from, 'cursor').catch((error: unknown) => {
    if (error instanceof DiagnosticError) {
      throw new DiagnosticError(error.diagnostics.map((entry) => ({
        ...entry,
        message: `${entry.message} The grokbot host installs the Cursor projection.`,
        target: grokBotHost,
      })));
    }
    throw error;
  });
  const root = grokBotRoot(options);
  try {
    const artifact = await bundleInventory(identity, { restoreModes: true });
    const receiptPath = grokBotReceiptPath(root, identity.plugin);
    const previousReceipt = await readInstallReceiptFile(receiptPath);
    const repoRoot = join(grokBotMarketplaceRoot(root), identity.plugin);
    const superseded = await supersedeOwnedStaging({ artifact, identity, options, previousReceipt, repoRoot, runner });
    let staged: Awaited<ReturnType<typeof stageCursorMarketplace>>;
    try {
      staged = await stageCursorMarketplace({ artifact, cursorRoot: root, identity, runner, treeHash });
    } catch (error) {
      if (superseded !== undefined) await rename(superseded, repoRoot);
      throw error;
    }
    try {
      if (
        staged.state === 'staged' ||
        previousReceipt === undefined ||
        previousReceipt.contentHash !== artifact.hash ||
        previousReceipt.registrations[0]?.commit !== staged.commit
      ) {
        await writeStoredInstallReceipt(receiptPath, createInstallReceipt({
          host: grokBotHost,
          ...(previousReceipt === undefined ? {} : { installedAt: previousReceipt.installedAt }),
          inventory: { files: [], hash: artifact.hash },
          mode: 'marketplace',
          plugin: identity.plugin,
          registrations: [{
            ...(staged.commit === undefined ? {} : { commit: staged.commit }),
            kind: 'grokbot-marketplace-staging',
            name: staged.marketplace,
          }],
          scope: 'user',
          updatedAt: new Date().toISOString(),
          version: identity.version,
        }));
      }
    } catch (error) {
      // Keep the receipt and the repository it names consistent: put the superseded staging back.
      if (superseded !== undefined) {
        await rm(staged.destination, { force: true, recursive: true });
        await rename(superseded, repoRoot);
      }
      throw error;
    }
    if (superseded !== undefined) await rm(superseded, { force: true, recursive: true });
    const sideload = await sideloadGrokBot({ artifact, identity, options, root });
    return {
      bundleRoot: identity.bundleRoot,
      ...(staged.commit === undefined ? {} : { commit: staged.commit }),
      contentHash: artifact.hash,
      destination: staged.destination,
      host: grokBotHost,
      marketplace: staged.marketplace,
      mode: 'marketplace',
      nextSteps: sideload.length === 0
        ? grokBotNextSteps(staged.destination, identity.plugin)
        : [...sideload.map(sideloadStep), ...grokBotNextSteps(staged.destination, identity.plugin)],
      ...(sideload.length === 0 ? {} : { sideload }),
      plugin: identity.plugin,
      ...(superseded === undefined || previousReceipt === undefined ? {} : { previousContentHash: previousReceipt.contentHash }),
      receipt: receiptPath,
      state: superseded === undefined ? staged.state : 'replaced',
      version: identity.version,
    };
  } catch (error) {
    if (error instanceof DiagnosticError) {
      throw new DiagnosticError(error.diagnostics.map((entry) => ({
        ...entry,
        message: grokBotStagingMessage(entry.message),
        target: grokBotHost,
      })));
    }
    throw failure('AB7004', errorMessage(error));
  }
};

/** Where a Grok Bot computer keeps its data, most specific first (`GROK_BOT_AGENT_DATA_DIR` overrides). */
export const grokBotAgentDataCandidates = (
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): readonly string[] => Object.freeze([
  ...(environment['GROK_BOT_AGENT_DATA_DIR'] === undefined ? [] : [environment['GROK_BOT_AGENT_DATA_DIR']]),
  '/home/box/agent-data',
  join(home, '.grokbot', 'agent-data'),
  join(home, 'Library', 'Application Support', 'Grok Bot', 'agent-data'),
]);

/** One copy of the plugin Grok Bot cloned, and the server-assigned id when its skill index names it. */
export interface GrokBotInstalledPlugin {
  /** `<agent-data>/plugins/cache/<marketplace>/<plugin>/<commit>`. */
  readonly installPath: string;
  /** Cache partition: Grok Bot's slug for the marketplace repository (`owner-repo`). */
  readonly marketplace: string;
  /** `version` from the cached `.cursor-plugin/plugin.json`. */
  readonly manifestVersion?: string;
  /** Server-assigned plugin id from `plugin-skills/cache.json`; absent when the plugin contributes no skill yet. */
  readonly pluginId?: string;
  /** The version Grok Bot installed: the marketplace commit for Git marketplaces. */
  readonly pluginVersion: string;
}

export type GrokBotInventory =
  | Readonly<{ readonly agentData: string; readonly entries: readonly GrokBotInstalledPlugin[]; readonly status: 'available' }>
  | Readonly<{ readonly reason: string; readonly status: 'unavailable' }>;

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EACCES')) return false;
    throw error;
  }
};

const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'EACCES') || error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const listDirectory = async (path: string): Promise<readonly string[]> => {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EACCES')) return [];
    throw error;
  }
};

/** `<marketplace>/<plugin>/<version>` -> plugin id, from the skill index Grok Bot keeps for installed plugins. */
const skillIndexIds = (document: unknown): ReadonlyMap<string, string> => {
  const ids = new Map<string, string>();
  if (!Predicate.isObject(document) || !Array.isArray(document['skills'])) return ids;
  for (const skill of document['skills'] as unknown[]) {
    if (!Predicate.isObject(skill)) continue;
    const { installPath, pluginId } = skill;
    if (typeof installPath !== 'string' || typeof pluginId !== 'string') continue;
    // The index may record the legacy `sand-data` root, so only the cache-relative tail identifies the copy.
    const segments = installPath.split(/[\\/]/u).filter((segment) => segment !== '');
    const cache = segments.lastIndexOf('cache');
    if (cache < 1 || segments[cache - 1] !== 'plugins' || segments.length !== cache + 4) continue;
    ids.set(segments.slice(cache + 1).join('/'), pluginId);
  }
  return ids;
};

/**
 * Every completed copy of `plugin` in Grok Bot's plugin cache, from any
 * marketplace, with the plugin id the skill index assigns it. Read-only.
 */
export const readGrokBotInventory = async (
  plugin: string,
  options: { readonly environment?: Readonly<NodeJS.ProcessEnv>; readonly home?: string } = {},
): Promise<GrokBotInventory> => {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  let agentData: string | undefined;
  for (const candidate of grokBotAgentDataCandidates(environment, home)) {
    if (await directoryExists(join(candidate, 'plugins'))) {
      agentData = candidate;
      break;
    }
  }
  if (agentData === undefined) {
    return Object.freeze({
      reason: 'No Grok Bot plugin cache on this computer (set GROK_BOT_AGENT_DATA_DIR, or run doctor on the Grok Bot computer).',
      status: 'unavailable',
    });
  }
  const ids = skillIndexIds(await readJsonFile(join(agentData, 'plugin-skills', 'cache.json')));
  const cacheRoot = join(agentData, 'plugins', 'cache');
  const entries: GrokBotInstalledPlugin[] = [];
  for (const marketplace of await listDirectory(cacheRoot)) {
    const pluginRoot = join(cacheRoot, marketplace, plugin);
    for (const version of await listDirectory(pluginRoot)) {
      const installPath = join(pluginRoot, version);
      if (!(await exists(join(installPath, '.cache-complete')))) continue;
      const manifest = await readJsonFile(join(installPath, '.cursor-plugin', 'plugin.json'));
      if (!Predicate.isObject(manifest) || manifest['name'] !== plugin) continue;
      const pluginId = ids.get(`${marketplace}/${plugin}/${version}`);
      entries.push(Object.freeze({
        installPath,
        marketplace,
        ...(typeof manifest['version'] === 'string' ? { manifestVersion: manifest['version'] } : {}),
        ...(pluginId === undefined ? {} : { pluginId }),
        pluginVersion: version,
      }));
    }
  }
  return Object.freeze({ agentData, entries: Object.freeze(entries), status: 'available' });
};

/**
 * Unofficial sideload into a marketplace Grok Bot already syncs.
 *
 * Grok Bot keeps a sparse snapshot of each account marketplace under
 * `<agent-data>/plugins/marketplaces/github.com/<owner>/<repo>/<commit>/` and a
 * completed copy of every installed plugin under
 * `<agent-data>/plugins/cache/<owner>-<repo>/<plugin>/<commit>/`. When the bundle's
 * repository owner (or `GROK_BOT_SIDELOAD_MARKETPLACE=owner/repo[,owner/repo]`)
 * names a marketplace that snapshot exists for, the installer mirrors the
 * plugin into it exactly as Grok Bot lays out its official plugins: the plugin
 * folder beside its siblings, an entry in that snapshot's
 * `.cursor-plugin/marketplace.json`, and a cache copy with `.cache-complete`.
 * The plugin id stays server-assigned: until the hosted marketplace lists the
 * plugin and the account installs it, Grok Bot's sync may prune these files,
 * and re-running the installer restores them. `GROK_BOT_SIDELOAD=0` disables it.
 * A record under `<grokbot root>/agent-bundle/sideload/<plugin>.json` lets
 * uninstall remove exactly what was written.
 */
export interface GrokBotSideloadEntry {
  /** `<owner>/<repo>` of the Grok Bot marketplace snapshot. */
  readonly marketplace: string;
  /** Snapshot commit the plugin was mirrored under. */
  readonly commit: string;
  /** `<snapshot>/<plugin>`. */
  readonly pluginPath: string;
  /** `<agent-data>/plugins/cache/<owner>-<repo>/<plugin>/<commit>`. */
  readonly cachePath: string;
  /** Whether this install added the plugin to the snapshot's marketplace.json (false when already listed). */
  readonly addedEntry: boolean;
}

interface GrokBotSideloadRecord {
  readonly entries: readonly GrokBotSideloadEntry[];
  readonly plugin: string;
  readonly version: string;
}

export const grokBotSideloadRecordPath = (root: string, plugin: string): string =>
  join(root, 'agent-bundle', 'sideload', `${plugin}.json`);

const sideloadStep = (entry: GrokBotSideloadEntry): string =>
  `Sideloaded into Grok Bot's ${entry.marketplace} marketplace snapshot @ ${entry.commit}: ${entry.pluginPath} ` +
  `and ${entry.cachePath} (unofficial; Grok Bot assigns the plugin id once the hosted marketplace lists the plugin).`;

const repositoryOwner = (repository: unknown): string | undefined => {
  const url = typeof repository === 'string'
    ? repository
    : Predicate.isObject(repository) && typeof repository['url'] === 'string' ? repository['url'] : undefined;
  return url?.match(/github\.com[/:]([^/]+)\//iu)?.[1]?.toLowerCase();
};

const readSideloadRecord = async (path: string): Promise<GrokBotSideloadRecord | undefined> => {
  const document = await readJsonFile(path);
  if (!Predicate.isObject(document) || !Array.isArray(document['entries'])) return undefined;
  return document as unknown as GrokBotSideloadRecord;
};

const grokBotAgentData = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<string | undefined> => {
  for (const candidate of grokBotAgentDataCandidates(environment, home)) {
    if (await directoryExists(join(candidate, 'plugins'))) return candidate;
  }
  return undefined;
};

/** `[owner, repo]` marketplace snapshots to sideload into, from the override or the bundle's repository owner. */
const sideloadTargets = async (
  marketplacesRoot: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  bundleRoot: string,
): Promise<readonly (readonly [string, string])[]> => {
  const override = environment['GROK_BOT_SIDELOAD_MARKETPLACE'];
  if (override !== undefined && override.trim() !== '') {
    return override.split(',').map((value) => value.trim().toLowerCase().split('/'))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '' && parts[1] !== '')
      .map(([owner, repo]) => [owner, repo] as const);
  }
  const manifest = await readJsonFile(join(bundleRoot, '.cursor-plugin', 'plugin.json'));
  const owner = Predicate.isObject(manifest) ? repositoryOwner(manifest['repository']) : undefined;
  if (owner === undefined) return [];
  return (await listDirectory(join(marketplacesRoot, owner))).map((repo) => [owner, repo] as const);
};

const marketplaceManifestFile = (snapshot: string): string => join(snapshot, '.cursor-plugin', 'marketplace.json');

const writeTree = async (bundleRoot: string, destination: string, artifact: TreeInventory): Promise<void> => {
  const stage = `${destination}.agent-bundle-stage-${process.pid}`;
  await rm(stage, { force: true, recursive: true });
  await copyInventoryFiles(bundleRoot, stage, artifact);
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await rename(stage, destination);
};

const sideloadGrokBot = async (options: {
  readonly artifact: TreeInventory;
  readonly identity: { readonly bundleRoot: string; readonly plugin: string; readonly version: string };
  readonly options: InstallBundleOptions;
  readonly root: string;
}): Promise<readonly GrokBotSideloadEntry[]> => {
  const environment = options.options.environment ?? process.env;
  if (environment['GROK_BOT_SIDELOAD'] === '0') return [];
  const agentData = await grokBotAgentData(environment, options.options.home ?? homedir());
  if (agentData === undefined) return [];
  const { artifact, identity } = options;
  const marketplacesRoot = join(agentData, 'plugins', 'marketplaces', 'github.com');
  const recordPath = grokBotSideloadRecordPath(options.root, identity.plugin);
  const previous = await readSideloadRecord(recordPath);
  const owned = new Set(previous?.entries.flatMap((entry) => [entry.pluginPath, entry.cachePath]) ?? []);
  const previouslyAdded = new Set(previous?.entries.filter((entry) => entry.addedEntry).map((entry) => entry.pluginPath) ?? []);
  const description = await readManifestDescription(identity.bundleRoot);
  const entries: GrokBotSideloadEntry[] = [];
  for (const [owner, repo] of await sideloadTargets(marketplacesRoot, environment, identity.bundleRoot)) {
    for (const commit of await listDirectory(join(marketplacesRoot, owner, repo))) {
      const snapshot = join(marketplacesRoot, owner, repo, commit);
      const manifestPath = marketplaceManifestFile(snapshot);
      const manifest = await readJsonFile(manifestPath);
      if (!Predicate.isObject(manifest) || !Array.isArray(manifest['plugins'])) continue;
      const plugins = manifest['plugins'] as unknown[];
      const pluginPath = join(snapshot, identity.plugin);
      const listed = plugins.some((entry) => Predicate.isObject(entry) && entry['name'] === identity.plugin);
      // The hosted marketplace already ships this plugin at this commit: Grok Bot owns it, leave it alone.
      if (listed && !owned.has(pluginPath) && await exists(pluginPath)) continue;
      const cachePath = join(agentData, 'plugins', 'cache', `${owner}-${repo}`, identity.plugin, commit);
      if (!owned.has(cachePath) && await exists(join(cachePath, '.cache-complete'))) continue;
      await writeTree(identity.bundleRoot, pluginPath, artifact);
      if (!listed) {
        plugins.push({ name: identity.plugin, source: identity.plugin, ...(description === undefined ? {} : { description }) });
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      await writeTree(identity.bundleRoot, cachePath, artifact);
      await writeFile(join(cachePath, '.cache-complete'), '');
      entries.push(Object.freeze({
        addedEntry: !listed || previouslyAdded.has(pluginPath),
        cachePath,
        commit,
        marketplace: `${owner}/${repo}`,
        pluginPath,
      }));
    }
  }
  if (entries.length > 0 || previous !== undefined) {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({ entries, plugin: identity.plugin, version: identity.version }, null, 2)}\n`);
  }
  return Object.freeze(entries);
};

const readManifestDescription = async (bundleRoot: string): Promise<string | undefined> => {
  const manifest = await readJsonFile(join(bundleRoot, '.cursor-plugin', 'plugin.json'));
  return Predicate.isObject(manifest) && typeof manifest['description'] === 'string' ? manifest['description'] : undefined;
};

/** Removes what `install grokbot` sideloaded (plugin folders, marketplace entries it added, cache copies) and its record. */
export const removeGrokBotSideload = async (root: string, plugin: string): Promise<readonly string[]> => {
  const recordPath = grokBotSideloadRecordPath(root, plugin);
  const record = await readSideloadRecord(recordPath);
  if (record === undefined) return [];
  const removed: string[] = [];
  for (const entry of record.entries) {
    if (entry.addedEntry) {
      const manifestPath = marketplaceManifestFile(dirname(entry.pluginPath));
      const manifest = await readJsonFile(manifestPath);
      if (Predicate.isObject(manifest) && Array.isArray(manifest['plugins'])) {
        const plugins = manifest['plugins'] as unknown[];
        const kept = plugins.filter((item) => !(Predicate.isObject(item) && item['name'] === plugin));
        if (kept.length !== plugins.length) {
          await writeFile(manifestPath, `${JSON.stringify({ ...manifest, plugins: kept }, null, 2)}\n`);
        }
      }
    }
    for (const path of [entry.pluginPath, entry.cachePath]) {
      if (await exists(path)) {
        await rm(path, { force: true, recursive: true });
        removed.push(path);
      }
    }
  }
  await rm(recordPath, { force: true });
  return Object.freeze(removed);
};
