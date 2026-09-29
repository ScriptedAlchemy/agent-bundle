import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Predicate } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { errorMessage, isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { cursorMarketplaceRoot, stageCursorMarketplace } from './cursor-marketplace.ts';
import { bundleInventory, readBundleIdentity } from './identity.ts';
import {
  type InstallReceipt,
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
 * installer only stages a committed marketplace repository built from the
 * Cursor projection, records a receipt, and prints the exact remaining steps.
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
    if (superseded !== undefined) await rm(superseded, { force: true, recursive: true });
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
    return {
      bundleRoot: identity.bundleRoot,
      ...(staged.commit === undefined ? {} : { commit: staged.commit }),
      contentHash: artifact.hash,
      destination: staged.destination,
      host: grokBotHost,
      marketplace: staged.marketplace,
      mode: 'marketplace',
      nextSteps: grokBotNextSteps(staged.destination, identity.plugin),
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
