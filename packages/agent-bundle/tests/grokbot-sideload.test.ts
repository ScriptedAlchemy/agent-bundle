import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import { runDoctor } from '../src/install/doctor.ts';
import { formatInstallResult, formatUninstallResult } from '../src/install/format.ts';
import { grokBotReceiptPath, readGrokBotInventory } from '../src/install/grokbot.ts';
import {
  applyGrokBotSideload,
  grokBotSideloadMarkerFile,
  planGrokBotSideload,
  resolveGrokBotSideloadSettings,
} from '../src/install/grokbot-sideload.ts';
import { bundleInventory, readBundleIdentity } from '../src/install/identity.ts';
import { installBundle, type InstallResult } from '../src/install/install.ts';
import { readGrokBotSideload, readInstallReceiptFile } from '../src/install/receipt.ts';
import { uninstallBundle } from '../src/install/uninstall.ts';
import { runInstallCli } from '../src/install/index.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';
import { removeTree } from './support/remove-tree.ts';

const commit = '0401b288f8d5b444bc445ed4c3ac2b94fb24e02c';
const nextCommit = '1111111111111111111111111111111111111111';

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const missing = async (path: string): Promise<void> => {
  await expect(access(path), path).rejects.toMatchObject({ code: 'ENOENT' });
};

interface Sandbox {
  readonly agentData: string;
  readonly cleanup: () => Promise<void>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly from: string;
  readonly home: string;
}

/** A built Cursor projection named `grok-fixture` and an isolated home with an empty Grok Bot agent-data root. */
const sandbox = async (): Promise<Sandbox> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-grokbot-sideload-')));
  const from = join(root, 'bundle');
  await mkdir(join(from, 'skills', 'talk'), { recursive: true });
  await writeFile(join(from, 'skills', 'talk', 'SKILL.md'), '---\nname: talk\ndescription: Talk.\n---\nTalk.\n');
  await writeJson(join(from, '.cursor-plugin/plugin.json'), { description: 'Grok fixture.', name: 'grok-fixture', version: '1.2.3' });
  await writeInstallFixtureManifest(from, { name: 'grok-fixture', version: '1.2.3' }, [{ host: 'cursor' }]);
  const agentData = join(root, 'agent-data');
  await mkdir(join(agentData, 'plugins', 'cache'), { recursive: true });
  const home = join(root, 'home');
  await mkdir(home);
  return { agentData, cleanup: () => removeTree(root), environment: { GROK_BOT_AGENT_DATA_DIR: agentData }, from, home };
};

const repoRoot = (box: Sandbox): string => join(box.agentData, 'plugins', 'marketplaces', 'github.com', 'scriptedalchemy', 'plugins');
const clonePath = (box: Sandbox, sha = commit): string => join(repoRoot(box), sha);
const cacheSlug = (box: Sandbox): string => join(box.agentData, 'plugins', 'cache', 'scriptedalchemy-plugins');

const upstreamManifest = {
  name: 'cursor-plugins',
  owner: { name: 'Cursor' },
  plugins: [
    { description: 'Go deep first.', name: 'pstack', source: 'pstack' },
    { minClientVersions: { grokbot: '0.49.0' }, name: 'finance', source: 'third_party/finance' },
  ],
};

/** What Grok Bot keeps after installing `pstack` from ScriptedAlchemy/plugins: a sparse clone at `sha` and a cache copy. */
const simulateGrokBotMarketplace = async (box: Sandbox, sha = commit): Promise<string> => {
  const clone = clonePath(box, sha);
  await writeFile(join(await mkdirp(join(clone, '.git')), 'HEAD'), `${sha}\n`);
  await writeJson(join(clone, '.cursor-plugin', 'marketplace.json'), upstreamManifest);
  await writeFile(join(await mkdirp(join(clone, 'pstack')), 'README.md'), 'pstack\n');
  const cache = join(cacheSlug(box), 'pstack', sha);
  await writeFile(join(await mkdirp(cache), 'README.md'), 'pstack\n');
  await writeFile(join(cache, '.cache-complete'), '');
  return clone;
};

const mkdirp = async (path: string): Promise<string> => {
  await mkdir(path, { recursive: true });
  return path;
};

const sideloadOf = (result: InstallResult): Extract<NonNullable<InstallResult['sideload']>, { readonly cachePath: string }> => {
  if (result.sideload === undefined || result.sideload.state === 'skipped') {
    throw new Error(`expected a sideload, got ${JSON.stringify(result.sideload)}`);
  }
  return result.sideload;
};

it('install grokbot sideloads into the active marketplace clone and plugin cache, idempotently, and uninstall removes exactly that', async () => {
  const box = await sandbox();
  try {
    const clone = await simulateGrokBotMarketplace(box);
    const manifestPath = join(clone, '.cursor-plugin', 'marketplace.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const result = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    const sideload = sideloadOf(result);
    expect(sideload.state).toBe('written');
    const pluginPath = join(clone, 'grok-fixture');
    const cachePath = join(cacheSlug(box), 'grok-fixture', commit);
    expect(sideload).toEqual({
      agentData: box.agentData,
      cachePath,
      commit,
      createdDirectories: [join(cacheSlug(box), 'grok-fixture')],
      entry: { description: 'Grok fixture.', name: 'grok-fixture', source: 'grok-fixture' },
      manifest: manifestPath,
      pluginPath,
      repo: 'scriptedalchemy/plugins',
      slug: 'scriptedalchemy-plugins',
      state: 'written',
    });
    for (const root of [pluginPath, cachePath]) {
      expect(await readFile(join(root, 'skills', 'talk', 'SKILL.md'), 'utf8')).toContain('name: talk');
      expect(JSON.parse(await readFile(join(root, grokBotSideloadMarkerFile), 'utf8'))).toMatchObject({ plugin: 'grok-fixture' });
    }
    await access(join(cachePath, '.cache-complete'));
    await missing(join(pluginPath, '.cache-complete'));
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual({
      ...upstreamManifest,
      plugins: [...upstreamManifest.plugins, { description: 'Grok fixture.', name: 'grok-fixture', source: 'grok-fixture' }],
    });
    // No staging or replaced siblings are left beside the written folders.
    expect(await readdir(clone)).toEqual(['.cursor-plugin', '.git', 'grok-fixture', 'pstack']);
    expect(await readdir(join(cacheSlug(box), 'grok-fixture'))).toEqual([commit]);
    expect(await readdir(dirname(manifestPath))).toEqual(['marketplace.json']);
    expect(result.nextSteps?.[0]).toContain('its next plugin sync removes the cache copy');
    expect(formatInstallResult(result)).toContain(`Grok Bot sideload: written (scriptedalchemy/plugins @ ${commit}, cache scriptedalchemy-plugins)`);

    const receipt = await readInstallReceiptFile(grokBotReceiptPath(join(box.home, '.grokbot'), 'grok-fixture'));
    expect(receipt?.grokBotSideload).toEqual({
      agentData: box.agentData,
      cachePath,
      commit,
      createdDirectories: [join(cacheSlug(box), 'grok-fixture')],
      entry: { description: 'Grok fixture.', name: 'grok-fixture', source: 'grok-fixture' },
      manifest: manifestPath,
      pluginPath,
      repo: 'scriptedalchemy/plugins',
      slug: 'scriptedalchemy-plugins',
    });
    expect(receipt?.registrations).toEqual([
      expect.objectContaining({ kind: 'grokbot-marketplace-staging' }),
      { commit, kind: 'grokbot-sideload', name: 'scriptedalchemy-plugins' },
    ]);
    // A sideload copy is not an install Grok Bot made.
    expect(await readGrokBotInventory('grok-fixture', { environment: box.environment, home: box.home })).toMatchObject({ entries: [] });

    const again = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(again).toMatchObject({ sideload: { state: 'unchanged' }, state: 'already-installed' });

    const doctor = await runDoctor({ environment: box.environment, from: box.from, home: box.home, hosts: ['grokbot'] });
    const grokbot = doctor.hosts.find((host) => host.host === 'grokbot');
    expect(grokbot?.receipts[0]?.sideload).toMatchObject({
      cacheCopy: true, cloneActive: true, listed: true, loaded: false, pluginFolder: true,
    });
    expect(grokbot?.diagnostics.find((entry) => entry.code === 'AB7335')).toMatchObject({
      message: expect.stringContaining('written'),
      severity: 'info',
    });

    const planned = await uninstallBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot', plan: true });
    expect(planned.removed.directories).toEqual(expect.arrayContaining([cachePath, pluginPath, join(cacheSlug(box), 'grok-fixture')]));
    expect(planned.registrations.at(-1)).toMatchObject({ action: 'planned', kind: 'grokbot-sideload' });
    await access(cachePath);
    await access(pluginPath);

    const removed = await uninstallBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(removed.state).toBe('uninstalled');
    expect(removed.registrations.at(-1)).toMatchObject({ action: 'removed', commit, kind: 'grokbot-sideload' });
    expect(formatUninstallResult(removed)).toContain(`and its entry in ${manifestPath}`);
    await missing(pluginPath);
    await missing(join(cacheSlug(box), 'grok-fixture'));
    expect(await readFile(manifestPath, 'utf8')).toBe(originalManifest);
    // Grok Bot's own plugin is untouched.
    await access(join(clone, 'pstack', 'README.md'));
    await access(join(cacheSlug(box), 'pstack', commit, '.cache-complete'));
  } finally {
    await box.cleanup();
  }
});

it('skips the sideload without failing when there is no clone, and never touches folders or entries it does not own', async () => {
  const box = await sandbox();
  try {
    const none = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(none.sideload).toMatchObject({ reason: expect.stringContaining('has no clone of this marketplace'), state: 'skipped' });
    expect(formatInstallResult(none)).toContain('Grok Bot sideload: skipped');

    const clone = await simulateGrokBotMarketplace(box);
    const manifestPath = join(clone, '.cursor-plugin', 'marketplace.json');
    // Grok Bot already installed a plugin with this name from the account: its cache folder carries no marker.
    const own = join(cacheSlug(box), 'grok-fixture', commit);
    await writeFile(join(await mkdirp(own), '.cache-complete'), '');
    const shadow = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(shadow.sideload).toMatchObject({ reason: expect.stringContaining('account install'), state: 'skipped' });
    expect(await readdir(own)).toEqual(['.cache-complete']);
    await missing(join(clone, 'grok-fixture'));
    await removeTree(join(cacheSlug(box), 'grok-fixture'));

    // A folder of the same name in the clone that agent-bundle did not write.
    await writeFile(join(await mkdirp(join(clone, 'grok-fixture')), 'README.md'), 'upstream\n');
    const foreign = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(foreign.sideload).toMatchObject({ reason: expect.stringContaining('was not written by agent-bundle'), state: 'skipped' });
    expect(await readdir(join(clone, 'grok-fixture'))).toEqual(['README.md']);
    await removeTree(join(clone, 'grok-fixture'));

    // A manifest entry of the same name that agent-bundle did not add.
    await writeJson(manifestPath, { ...upstreamManifest, plugins: [...upstreamManifest.plugins, { name: 'grok-fixture', source: 'elsewhere' }] });
    const listed = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(listed.sideload).toMatchObject({ reason: expect.stringContaining('did not add'), state: 'skipped' });
    await missing(join(cacheSlug(box), 'grok-fixture'));
  } finally {
    await box.cleanup();
  }
});

it('configures the sideload repository and slug, honours --no-sideload and GROK_BOT_SIDELOAD=0, and rejects bad values', async () => {
  expect(resolveGrokBotSideloadSettings({}, {})).toEqual({ enabled: true, repo: 'scriptedalchemy/plugins', slug: 'scriptedalchemy-plugins' });
  expect(resolveGrokBotSideloadSettings({}, { GROK_BOT_SIDELOAD: '0', GROK_BOT_SIDELOAD_REPO: 'https://github.com/Acme/Market.git' }))
    .toEqual({ enabled: false, repo: 'acme/market', slug: 'acme-market' });
  expect(resolveGrokBotSideloadSettings({ sideload: true, sideloadSlug: 'acme_x' }, { GROK_BOT_SIDELOAD: 'off' }))
    .toEqual({ enabled: true, repo: 'scriptedalchemy/plugins', slug: 'acme_x' });
  expect(() => resolveGrokBotSideloadSettings({ sideloadRepo: '../etc' }, {})).toThrow(DiagnosticError);
  expect(() => resolveGrokBotSideloadSettings({ sideloadSlug: 'a/b' }, {})).toThrow(/may contain only/u);

  const box = await sandbox();
  try {
    const acme = join(box.agentData, 'plugins', 'marketplaces', 'github.com', 'acme', 'market', commit);
    await writeFile(join(await mkdirp(join(acme, '.git')), 'HEAD'), `${commit}\n`);
    await writeJson(join(acme, '.claude-plugin', 'marketplace.json'), { name: 'acme', plugins: [] });
    await expect(installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'cursor', sideload: false }))
      .rejects.toThrow('Sideload options apply to the grokbot host only.');
    const off = await installBundle({ environment: { ...box.environment, GROK_BOT_SIDELOAD: '0' }, from: box.from, home: box.home, host: 'grokbot' });
    expect(off.sideload).toMatchObject({ state: 'skipped' });
    await missing(join(acme, 'grok-fixture'));

    let stdout = '';
    const previous = process.env['GROK_BOT_AGENT_DATA_DIR'];
    const previousHome = process.env['GROK_BOT_HOME'];
    process.env['GROK_BOT_AGENT_DATA_DIR'] = box.agentData;
    process.env['GROK_BOT_HOME'] = join(box.home, '.grokbot');
    try {
      const run = (argv: readonly string[]): Promise<number> =>
        runInstallCli(argv, { from: box.from, name: 'fixture-install', stderr: () => undefined, stdout: (text) => { stdout += text; } });
      expect(await run(['install', 'grokbot', '--no-sideload'])).toBe(0);
      expect(stdout).toContain('Grok Bot sideload: skipped — disabled');
      stdout = '';
      expect(await run(['install', 'grokbot', '--sideload-repo', 'acme/market', '--sideload-slug', 'acme'])).toBe(0);
      expect(stdout).toContain(`Grok Bot sideload: written (acme/market @ ${commit}, cache acme)`);
    } finally {
      if (previous === undefined) delete process.env['GROK_BOT_AGENT_DATA_DIR'];
      else process.env['GROK_BOT_AGENT_DATA_DIR'] = previous;
      if (previousHome === undefined) delete process.env['GROK_BOT_HOME'];
      else process.env['GROK_BOT_HOME'] = previousHome;
    }
    // The Claude manifest fallback is the one updated, keeping its two-space layout and trailing newline.
    expect(await readFile(join(acme, '.claude-plugin', 'marketplace.json'), 'utf8')).toBe(
      `${JSON.stringify({ name: 'acme', plugins: [{ name: 'grok-fixture', source: 'grok-fixture', description: 'Grok fixture.' }] }, null, 2)}\n`,
    );
    await access(join(box.agentData, 'plugins', 'cache', 'acme', 'grok-fixture', commit, '.cache-complete'));
  } finally {
    await box.cleanup();
  }
});

it('follows Grok Bot to a new marketplace commit, picks the live clone mid-reclone, and reports what its sync removed', async () => {
  const box = await sandbox();
  try {
    await simulateGrokBotMarketplace(box);
    const first = sideloadOf(await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' }));

    // Grok Bot's sync prunes the cache folder of a plugin its account listing does not name.
    await removeTree(join(cacheSlug(box), 'grok-fixture'));
    let doctor = await runDoctor({ environment: box.environment, from: box.from, home: box.home, hosts: ['grokbot'] });
    expect(doctor.hosts[0]?.diagnostics.find((entry) => entry.code === 'AB7335')).toMatchObject({
      message: expect.stringContaining('removed by Grok Bot\'s plugin sync'),
      severity: 'warning',
    });

    // Mid-reclone: a second clone exists and pstack's cache copy already uses it.
    await simulateGrokBotMarketplace(box, nextCommit);
    await removeTree(join(cacheSlug(box), 'pstack', commit));
    const moved = sideloadOf(await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' }));
    expect(moved).toMatchObject({ commit: nextCommit, pluginPath: join(clonePath(box, nextCommit), 'grok-fixture'), state: 'written' });
    // The superseded sideload in the old clone is removed, entry included; nothing else there changes.
    await missing(first.pluginPath);
    expect(JSON.parse(await readFile(first.manifest, 'utf8'))).toEqual(upstreamManifest);
    expect(await readdir(join(cacheSlug(box), 'grok-fixture'))).toEqual([nextCommit]);

    // Grok Bot indexed the copy: the account lists the plugin and Grok Bot loaded the sideloaded files.
    await writeJson(join(box.agentData, 'plugin-skills', 'cache.json'), {
      installFolders: [{ installPath: `/home/box/sand-data/plugins/cache/scriptedalchemy-plugins/grok-fixture/${nextCommit}`, pluginId: '7' }],
      skills: [],
    });
    doctor = await runDoctor({ environment: box.environment, from: box.from, home: box.home, hosts: ['grokbot'] });
    expect(doctor.hosts[0]?.diagnostics.find((entry) => entry.code === 'AB7335')).toMatchObject({
      message: expect.stringContaining('loaded'),
      severity: 'info',
    });

    // Two clones whose plugins' cache copies use both commits: no clone is clearly the live one.
    await removeTree(clonePath(box, commit));
    await simulateGrokBotMarketplace(box, commit);
    const ambiguous = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(ambiguous.sideload).toMatchObject({ reason: expect.stringContaining('none is clearly active'), state: 'skipped' });
    // The skipped run keeps the previous record, so uninstall still finds the sideload.
    const removed = await uninstallBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(removed.registrations.at(-1)).toMatchObject({ action: 'removed', commit: nextCommit, kind: 'grokbot-sideload' });
    await missing(moved.pluginPath);
    await missing(join(cacheSlug(box), 'grok-fixture'));
  } finally {
    await box.cleanup();
  }
});

it('accepts a receipt sideload record only when every path derives from its own fields', () => {
  const agentData = join(tmpdir(), 'grok-agent-data');
  const clone = join(agentData, 'plugins', 'marketplaces', 'github.com', 'scriptedalchemy', 'plugins', commit);
  const cacheRoot = join(agentData, 'plugins', 'cache');
  const valid = {
    agentData,
    cachePath: join(cacheRoot, 'scriptedalchemy-plugins', 'grok-fixture', commit),
    commit,
    createdDirectories: [join(cacheRoot, 'scriptedalchemy-plugins', 'grok-fixture')],
    entry: { name: 'grok-fixture', source: 'grok-fixture' },
    manifest: join(clone, '.cursor-plugin', 'marketplace.json'),
    pluginPath: join(clone, 'grok-fixture'),
    repo: 'scriptedalchemy/plugins',
    slug: 'scriptedalchemy-plugins',
  };
  expect(readGrokBotSideload(valid, 'grok-fixture')).toEqual(valid);
  expect(readGrokBotSideload({ ...valid, manifest: join(clone, '.claude-plugin', 'marketplace.json') }, 'grok-fixture')).toBeDefined();
  expect(readGrokBotSideload({ ...valid, pluginPath: join(clone, 'plugins', 'grok-fixture') }, 'grok-fixture')).toBeDefined();
  for (const corrupt of [
    { cachePath: join(cacheRoot, 'scriptedalchemy-plugins', 'pstack', commit) },
    { cachePath: join(tmpdir(), 'elsewhere') },
    { pluginPath: join(clone, 'pstack') },
    { pluginPath: join(clone, '.git', 'grok-fixture') },
    { pluginPath: join(dirname(clone), nextCommit, 'grok-fixture') },
    { manifest: join(clone, 'pstack', 'marketplace.json') },
    { createdDirectories: [join(cacheRoot, 'scriptedalchemy-plugins', 'pstack')] },
    { createdDirectories: [cacheRoot] },
    { createdDirectories: [clone] },
    { createdDirectories: [join(cacheRoot, 'scriptedalchemy-plugins', 'grok-fixture', commit)] },
    { createdDirectories: [join(clone, 'grok-fixture')] },
    { commit: 'main' },
    { repo: 'scriptedalchemy/../etc' },
    { slug: '../x' },
    { entry: { name: 'pstack', source: 'pstack' } },
    { entry: { name: 'grok-fixture', source: { path: 'x' } } },
    { agentData: `${agentData}${'/'}` },
  ]) {
    expect(readGrokBotSideload({ ...valid, ...corrupt }, 'grok-fixture')).toBeUndefined();
  }
  expect(readGrokBotSideload(valid, 'pstack')).toBeUndefined();
});

it('leaves a replaced manifest entry alone and never reports a pruned sideload as loaded from a stale index', async () => {
  const box = await sandbox();
  try {
    const clone = await simulateGrokBotMarketplace(box);
    const sideload = sideloadOf(await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' }));
    // The clone folder disappears and the same name comes back as an entry agent-bundle did not write.
    await removeTree(sideload.pluginPath);
    const replaced = { ...upstreamManifest, plugins: [...upstreamManifest.plugins, { name: 'grok-fixture', source: './upstream/grok-fixture' }] };
    await writeJson(sideload.manifest, replaced);
    await writeJson(join(box.agentData, 'plugin-skills', 'cache.json'), {
      installFolders: [{ installPath: sideload.cachePath, pluginId: '9' }],
      skills: [],
    });
    const doctor = await runDoctor({ environment: box.environment, from: box.from, home: box.home, hosts: ['grokbot'] });
    expect(doctor.hosts[0]?.diagnostics.find((entry) => entry.code === 'AB7335')).toMatchObject({
      message: expect.stringMatching(/incomplete.*the clone folder.*the entry in.*still names the cache copy/u),
      severity: 'warning',
    });
    // A rerun does not claim the foreign entry either.
    const rerun = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(rerun.sideload).toMatchObject({ reason: expect.stringContaining('did not add'), state: 'skipped' });
    const removed = await uninstallBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(removed.retained).toContain(sideload.manifest);
    expect(JSON.parse(await readFile(sideload.manifest, 'utf8'))).toEqual(replaced);
    await missing(join(cacheSlug(box), 'grok-fixture'));
    expect(await readdir(clone)).toEqual(['.cursor-plugin', '.git', 'pstack']);
  } finally {
    await box.cleanup();
  }
});

it('re-reads the manifest before writing: keeps entries Grok Bot added meanwhile and refuses a foreign same-name entry', async () => {
  const box = await sandbox();
  try {
    const clone = await simulateGrokBotMarketplace(box);
    const manifestPath = join(clone, '.cursor-plugin', 'marketplace.json');
    const identity = await readBundleIdentity(box.from, 'cursor');
    const artifact = await bundleInventory(identity);
    const settings = resolveGrokBotSideloadSettings({}, box.environment);
    const plan = async () => {
      const planned = await planGrokBotSideload({ environment: box.environment, home: box.home, plugin: 'grok-fixture', settings });
      if (planned.state !== 'ready') throw new Error(planned.reason);
      return planned.target;
    };

    let target = await plan();
    const foreign = { ...upstreamManifest, plugins: [...upstreamManifest.plugins, { name: 'grok-fixture', source: 'theirs' }] };
    await writeJson(manifestPath, foreign);
    const progress = { started: false };
    await expect(applyGrokBotSideload({ artifact, bundleRoot: identity.bundleRoot, plugin: 'grok-fixture', progress, target }))
      .rejects.toThrow(/did not add/u);
    expect(progress.started).toBe(false);
    await missing(join(cacheSlug(box), 'grok-fixture'));
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(foreign);

    await writeJson(manifestPath, upstreamManifest);
    target = await plan();
    const grown = { ...upstreamManifest, plugins: [...upstreamManifest.plugins, { name: 'advisor', source: 'advisor' }] };
    await writeJson(manifestPath, grown);
    await applyGrokBotSideload({ artifact, bundleRoot: identity.bundleRoot, plugin: 'grok-fixture', progress, target });
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual({
      ...grown,
      plugins: [...grown.plugins, { name: 'grok-fixture', source: 'grok-fixture' }],
    });
  } finally {
    await box.cleanup();
  }
});

const permissionsApply = process.platform !== 'win32' && process.getuid?.() !== 0;

it.skipIf(!permissionsApply)('rolls a sideload back when the manifest or the receipt cannot be written, leaving nothing unrecorded', async () => {
  const box = await sandbox();
  const locked: string[] = [];
  const lock = async (path: string): Promise<void> => {
    await chmod(path, 0o555);
    locked.push(path);
  };
  try {
    const clone = await simulateGrokBotMarketplace(box);
    const manifestPath = join(clone, '.cursor-plugin', 'marketplace.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const install = () => installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });

    // The manifest rename fails after both folders landed: they are removed again, the manifest is untouched.
    await lock(dirname(manifestPath));
    await expect(install()).rejects.toThrow();
    await missing(join(clone, 'grok-fixture'));
    await missing(join(cacheSlug(box), 'grok-fixture'));
    expect(await readFile(manifestPath, 'utf8')).toBe(originalManifest);
    expect((await readInstallReceiptFile(grokBotReceiptPath(join(box.home, '.grokbot'), 'grok-fixture')))?.grokBotSideload).toBeUndefined();
    await chmod(locked.pop() as string, 0o755);

    // The receipt write fails after the sideload landed: it is rolled back, and the earlier receipt stays valid.
    const first = sideloadOf(await install());
    const receiptPath = grokBotReceiptPath(join(box.home, '.grokbot'), 'grok-fixture');
    const before = await readFile(receiptPath, 'utf8');
    await writeFile(join(box.from, 'skills', 'talk', 'SKILL.md'), '---\nname: talk\ndescription: Talk more.\n---\nTalk.\n');
    await writeInstallFixtureManifest(box.from, { name: 'grok-fixture', version: '1.2.3' }, [{ host: 'cursor' }]);
    await lock(dirname(receiptPath));
    await expect(install()).rejects.toThrow();
    expect(await readFile(receiptPath, 'utf8')).toBe(before);
    await missing(first.pluginPath);
    await missing(first.cachePath);
    expect(await readFile(manifestPath, 'utf8')).toBe(originalManifest);
    await chmod(locked.pop() as string, 0o755);
    const doctor = await runDoctor({ environment: box.environment, from: box.from, home: box.home, hosts: ['grokbot'] });
    expect(doctor.hosts[0]?.diagnostics.find((entry) => entry.code === 'AB7335')).toMatchObject({ severity: 'warning' });
    expect(sideloadOf(await install()).state).toBe('written');
  } finally {
    for (const path of locked) await chmod(path, 0o755);
    await box.cleanup();
  }
});

it.skipIf(process.platform === 'win32')('skips a target reached through a symbolic link', async () => {
  const box = await sandbox();
  try {
    await simulateGrokBotMarketplace(box);
    const elsewhere = await mkdirp(join(box.home, 'elsewhere'));
    await symlink(elsewhere, join(cacheSlug(box), 'grok-fixture'));
    const result = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(result.sideload).toMatchObject({ state: 'skipped' });
    expect(await readdir(elsewhere)).toEqual([]);
  } finally {
    await box.cleanup();
  }
});

it('normalizes GROK_BOT_AGENT_DATA_DIR and clears interrupted swaps without deleting a folder it cannot prove is its own', async () => {
  const box = await sandbox();
  try {
    const clone = await simulateGrokBotMarketplace(box);
    const environment = { GROK_BOT_AGENT_DATA_DIR: `${box.agentData}/plugins/../` };
    const install = () => installBundle({ environment, from: box.from, home: box.home, host: 'grokbot' });
    const first = sideloadOf(await install());
    expect(first.agentData).toBe(box.agentData);
    const receiptPath = grokBotReceiptPath(join(box.home, '.grokbot'), 'grok-fixture');
    expect((await readInstallReceiptFile(receiptPath))?.grokBotSideload).toMatchObject({ agentData: box.agentData });

    // A marked aside left by an interrupted swap is deleted by the next write.
    const scratch = (name: string): string => join(clone, `.grok-fixture.agent-bundle-${name}.replaced`);
    const ownAside = scratch('00000000-0000-4000-8000-000000000000');
    await writeJson(join(ownAside, grokBotSideloadMarkerFile), { format: 'agent-bundle-grokbot-sideload@1', plugin: 'grok-fixture' });
    await writeFile(join(box.from, 'skills', 'talk', 'SKILL.md'), '---\nname: talk\ndescription: Talk again.\n---\nTalk.\n');
    await writeInstallFixtureManifest(box.from, { name: 'grok-fixture', version: '1.2.3' }, [{ host: 'cursor' }]);
    expect(sideloadOf(await install()).state).toBe('written');
    await missing(ownAside);

    // An unmarked aside is someone else's folder caught mid-swap: it is put back where it was, never deleted.
    await uninstallBundle({ environment, from: box.from, home: box.home, host: 'grokbot' });
    const foreignAside = scratch('11111111-1111-4111-8111-111111111111');
    await writeFile(join(await mkdirp(foreignAside), 'theirs.txt'), 'theirs\n');
    await expect(install()).rejects.toThrow(/without agent-bundle's sideload marker/u);
    expect(await readFile(join(clone, 'grok-fixture', 'theirs.txt'), 'utf8')).toBe('theirs\n');
    await missing(foreignAside);
    await missing(join(cacheSlug(box), 'grok-fixture'));
  } finally {
    await box.cleanup();
  }
});

it('retires the first sideload release record: its folders and entry are replaced by marked, receipted ones', async () => {
  const box = await sandbox();
  try {
    const clone = await simulateGrokBotMarketplace(box);
    const manifestPath = join(clone, '.cursor-plugin', 'marketplace.json');
    // What #875 left: unmarked copies, its `{ name, source, description }` entry, and a record beside the receipts.
    const pluginPath = join(clone, 'grok-fixture');
    const cachePath = join(cacheSlug(box), 'grok-fixture', commit);
    for (const path of [pluginPath, cachePath]) {
      await writeJson(join(path, '.cursor-plugin', 'plugin.json'), { name: 'grok-fixture', version: '1.0.0' });
    }
    await writeFile(join(cachePath, '.cache-complete'), '');
    const legacyEntry = { description: 'Old.', name: 'grok-fixture', source: 'grok-fixture' };
    await writeJson(manifestPath, { ...upstreamManifest, plugins: [...upstreamManifest.plugins, legacyEntry] });
    const record = join(box.home, '.grokbot', 'agent-bundle', 'sideload', 'grok-fixture.json');
    const entries = [{ addedEntry: true, cachePath, commit, marketplace: 'scriptedalchemy/plugins', pluginPath }];
    await writeJson(record, { entries, plugin: 'grok-fixture', version: '1.0.0' });

    // The old env var still names the marketplace (one repository only).
    const environment = { ...box.environment, GROK_BOT_SIDELOAD_MARKETPLACE: 'scriptedalchemy/plugins' };
    const result = await installBundle({ environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(sideloadOf(result)).toMatchObject({ cachePath, pluginPath, state: 'written' });
    expect(result.nextSteps).toContainEqual(expect.stringContaining(`Retired the earlier sideload record ${record}`));
    await missing(record);
    expect(JSON.parse(await readFile(join(pluginPath, grokBotSideloadMarkerFile), 'utf8'))).toMatchObject({ plugin: 'grok-fixture' });
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).plugins).toEqual([
      ...upstreamManifest.plugins,
      { description: 'Grok fixture.', name: 'grok-fixture', source: 'grok-fixture' },
    ]);
    expect(() => resolveGrokBotSideloadSettings({}, { GROK_BOT_SIDELOAD_MARKETPLACE: 'a/b,c/d' })).toThrow(/several repositories/u);

    // Uninstall with only a legacy record (no receipt sideload) removes what it names, nothing else.
    await uninstallBundle({ environment, from: box.from, home: box.home, host: 'grokbot' });
    for (const path of [pluginPath, cachePath]) {
      await writeJson(join(path, '.cursor-plugin', 'plugin.json'), { name: 'grok-fixture', version: '1.0.0' });
    }
    await writeJson(manifestPath, { ...upstreamManifest, plugins: [...upstreamManifest.plugins, legacyEntry] });
    await writeJson(record, { entries, plugin: 'grok-fixture', version: '1.0.0' });
    await installBundle({ environment: { ...environment, GROK_BOT_SIDELOAD: '0' }, from: box.from, home: box.home, host: 'grokbot' });
    await access(record);
    const removed = await uninstallBundle({ environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(removed.registrations.at(-1)).toMatchObject({ action: 'removed', kind: 'grokbot-sideload' });
    await missing(record);
    await missing(pluginPath);
    await missing(cachePath);
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(upstreamManifest);
    await access(join(clone, 'pstack', 'README.md'));
  } finally {
    await box.cleanup();
  }
});
