import { rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Predicate } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { errorMessage } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { cursorMarketplaceRoot, stageCursorMarketplace } from './cursor-marketplace.ts';
import { findGrokBotAgentData, listDirectory, pluginCacheKey, readJsonFile } from './grokbot-agent-data.ts';
import {
  type GrokBotSideloadResult,
  applyGrokBotSideload,
  finishGrokBotSideload,
  ownsGrokBotSideloadPath,
  planGrokBotSideload,
  resolveGrokBotSideloadSettings,
  rollbackGrokBotSideload,
} from './grokbot-sideload.ts';
import { bundleInventory, readBundleIdentity } from './identity.ts';
import {
  type InstallReceipt,
  type InstallReceiptGrokBotSideload,
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
 * projection, records a receipt, and prints the exact remaining steps. When
 * this computer has Grok Bot data and a clone of the configured marketplace,
 * it also sideloads the plugin into that clone and Grok Bot's plugin cache
 * (install/grokbot-sideload.ts, which documents what Grok Bot's sync keeps).
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

const withoutState = (result: InstallReceiptGrokBotSideload & { readonly state: string }): InstallReceiptGrokBotSideload => {
  const { state: _state, ...record } = result;
  return record;
};

export const grokBotSideloadStep = (plugin: string, sideload: InstallReceiptGrokBotSideload): string =>
  `Sideloaded into Grok Bot's ${sideload.repo} marketplace clone @ ${sideload.commit} (${sideload.pluginPath}, listed in ` +
  `${sideload.manifest}) and its plugin cache (${sideload.cachePath}). Grok Bot loads plugins only from its account ` +
  `plugin listing: until that lists "${plugin}" from ${sideload.slug}, its next plugin sync removes the cache copy, and a ` +
  'new marketplace commit replaces the clone folder. Rerun this install to restore both; `doctor --host grokbot` reports which remain.';

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
  const environment = options.environment ?? process.env;
  const settings = resolveGrokBotSideloadSettings(options, environment);
  try {
    const artifact = await bundleInventory(identity, { restoreModes: true });
    const receiptPath = grokBotReceiptPath(root, identity.plugin);
    const previousReceipt = await readInstallReceiptFile(receiptPath);
    const previousSideload = previousReceipt?.plugin === identity.plugin ? previousReceipt.grokBotSideload : undefined;
    const manifest = await readJsonFile(join(identity.bundleRoot, '.cursor-plugin', 'plugin.json'));
    const description = Predicate.isObject(manifest) && typeof manifest['description'] === 'string' ? manifest['description'] : undefined;
    // Read-only, before anything is staged: where the sideload will write, or why it is skipped.
    const plan = await planGrokBotSideload({
      ...(description === undefined ? {} : { description }),
      environment,
      home: options.home ?? homedir(),
      plugin: identity.plugin,
      ...(previousSideload === undefined ? {} : { previous: previousSideload }),
      settings,
    });
    const repoRoot = join(grokBotMarketplaceRoot(root), identity.plugin);
    const superseded = await supersedeOwnedStaging({ artifact, identity, options, previousReceipt, repoRoot, runner });
    let staged: Awaited<ReturnType<typeof stageCursorMarketplace>>;
    try {
      staged = await stageCursorMarketplace({ artifact, cursorRoot: root, identity, runner, treeHash });
    } catch (error) {
      if (superseded !== undefined) await rename(superseded, repoRoot);
      throw error;
    }
    let sideload: GrokBotSideloadResult;
    const progress = { started: false };
    try {
      sideload = plan.state === 'ready'
        ? await applyGrokBotSideload({
          artifact,
          bundleRoot: identity.bundleRoot,
          plugin: identity.plugin,
          ...(previousSideload === undefined ? {} : { previous: previousSideload }),
          ...(previousReceipt === undefined ? {} : { previousContentHash: previousReceipt.contentHash }),
          progress,
          target: plan.target,
        })
        : plan;
      // A skipped sideload keeps the previous record: whatever it wrote may still exist, and uninstall must find it.
      const sideloadRecord = sideload.state === 'skipped' ? previousSideload : withoutState(sideload);
      if (
        staged.state === 'staged' ||
        previousReceipt === undefined ||
        previousReceipt.contentHash !== artifact.hash ||
        previousReceipt.registrations[0]?.commit !== staged.commit ||
        JSON.stringify(previousReceipt.grokBotSideload) !== JSON.stringify(sideloadRecord)
      ) {
        await writeStoredInstallReceipt(receiptPath, createInstallReceipt({
          ...(sideloadRecord === undefined ? {} : { grokBotSideload: sideloadRecord }),
          host: grokBotHost,
          ...(previousReceipt === undefined ? {} : { installedAt: previousReceipt.installedAt }),
          inventory: { files: [], hash: artifact.hash },
          mode: 'marketplace',
          plugin: identity.plugin,
          registrations: [
            {
              ...(staged.commit === undefined ? {} : { commit: staged.commit }),
              kind: 'grokbot-marketplace-staging',
              name: staged.marketplace,
            },
            ...(sideloadRecord === undefined
              ? []
              : [{ commit: sideloadRecord.commit, kind: 'grokbot-sideload' as const, name: sideloadRecord.slug }]),
          ],
          scope: 'user',
          updatedAt: new Date().toISOString(),
          version: identity.version,
        }));
      }
    } catch (error) {
      // Nothing the receipt does not name stays behind: undo a sideload written before the failure.
      if (plan.state === 'ready' && progress.started) {
        await rollbackGrokBotSideload({
          plugin: identity.plugin,
          ...(previousSideload === undefined ? {} : { previous: previousSideload }),
          target: plan.target,
        });
      }
      // Keep the receipt and the repository it names consistent: put the superseded staging back.
      if (superseded !== undefined) {
        await rm(staged.destination, { force: true, recursive: true });
        await rename(superseded, repoRoot);
      }
      throw error;
    }
    if (superseded !== undefined) await rm(superseded, { force: true, recursive: true });
    const cleanup: string[] = [];
    if (plan.state === 'ready' && sideload.state === 'written') {
      // The receipt now names the new sideload, so the copies it supersedes can go; a failure here strands only
      // marked copies the next install or Grok Bot's own pruning removes.
      await finishGrokBotSideload({
        plugin: identity.plugin,
        ...(previousSideload === undefined ? {} : { previous: previousSideload }),
        target: plan.target,
      }).catch((error: unknown) => {
        cleanup.push(`Could not remove the superseded Grok Bot sideload copies (${errorMessage(error)}); rerun this install to retry.`);
      });
    }
    return {
      bundleRoot: identity.bundleRoot,
      ...(staged.commit === undefined ? {} : { commit: staged.commit }),
      contentHash: artifact.hash,
      destination: staged.destination,
      host: grokBotHost,
      marketplace: staged.marketplace,
      mode: 'marketplace',
      nextSteps: [
        ...(sideload.state === 'skipped' ? [] : [grokBotSideloadStep(identity.plugin, sideload)]),
        ...cleanup,
        ...grokBotNextSteps(staged.destination, identity.plugin),
      ],
      plugin: identity.plugin,
      ...(superseded === undefined || previousReceipt === undefined ? {} : { previousContentHash: previousReceipt.contentHash }),
      receipt: receiptPath,
      sideload,
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

/** `<marketplace>/<plugin>/<version>` -> plugin id, from the skill index Grok Bot keeps for installed plugins. */
const skillIndexIds = (document: unknown): ReadonlyMap<string, string> => {
  const ids = new Map<string, string>();
  if (!Predicate.isObject(document) || !Array.isArray(document['skills'])) return ids;
  for (const skill of document['skills'] as unknown[]) {
    if (!Predicate.isObject(skill)) continue;
    const { installPath, pluginId } = skill;
    if (typeof installPath !== 'string' || typeof pluginId !== 'string') continue;
    const key = pluginCacheKey(installPath);
    if (key !== undefined) ids.set(key, pluginId);
  }
  return ids;
};

/**
 * Every completed copy of `plugin` in Grok Bot's plugin cache, from any
 * marketplace, with the plugin id the skill index assigns it. A sideload copy
 * counts only once Grok Bot's index names it. Read-only.
 */
export const readGrokBotInventory = async (
  plugin: string,
  options: { readonly environment?: Readonly<NodeJS.ProcessEnv>; readonly home?: string } = {},
): Promise<GrokBotInventory> => {
  const agentData = await findGrokBotAgentData(options.environment ?? process.env, options.home ?? homedir());
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
      // `install grokbot`'s own sideload copy is not an install Grok Bot made, until Grok Bot indexes it.
      if (pluginId === undefined && await ownsGrokBotSideloadPath(installPath, plugin)) continue;
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
