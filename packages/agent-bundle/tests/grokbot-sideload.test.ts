import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import { runDoctor } from '../src/install/doctor.ts';
import { formatInstallResult, formatUninstallResult } from '../src/install/format.ts';
import { grokBotReceiptPath, readGrokBotInventory } from '../src/install/grokbot.ts';
import { grokBotSideloadMarkerFile, resolveGrokBotSideloadSettings } from '../src/install/grokbot-sideload.ts';
import { installBundle, type InstallResult } from '../src/install/install.ts';
import { readInstallReceiptFile } from '../src/install/receipt.ts';
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
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
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
