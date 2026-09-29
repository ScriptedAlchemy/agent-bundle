import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import { runDoctor } from '../src/install/doctor.ts';
import { formatDoctorReport, formatInstallResult, formatUninstallResult } from '../src/install/format.ts';
import { grokBotReceiptPath, grokBotRoot, grokBotStagingMessage, readGrokBotInventory } from '../src/install/grokbot.ts';
import { installBundle } from '../src/install/install.ts';
import { readInstallReceiptFile } from '../src/install/receipt.ts';
import { uninstallBundle } from '../src/install/uninstall.ts';
import { runInstallCli } from '../src/install/index.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';
import { removeTree } from './support/remove-tree.ts';

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

interface Sandbox {
  readonly agentData: string;
  readonly cleanup: () => Promise<void>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly from: string;
  readonly home: string;
}

/** A built Cursor projection named `grok-fixture`, an isolated home, and an empty Grok Bot agent-data root. */
const sandbox = async (): Promise<Sandbox> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-grokbot-')));
  const from = join(root, 'bundle');
  await mkdir(from, { recursive: true });
  await writeFile(join(from, 'payload.txt'), 'payload\n');
  await writeJson(join(from, '.cursor-plugin/plugin.json'), { name: 'grok-fixture', version: '1.2.3' });
  await writeInstallFixtureManifest(from, { name: 'grok-fixture', version: '1.2.3' }, [{ host: 'cursor' }]);
  const agentData = join(root, 'agent-data');
  await mkdir(join(agentData, 'plugins', 'cache'), { recursive: true });
  const home = join(root, 'home');
  await mkdir(home);
  return {
    agentData,
    cleanup: () => removeTree(root),
    environment: { GROK_BOT_AGENT_DATA_DIR: agentData },
    from,
    home,
  };
};

/** What Grok Bot leaves after installing the plugin from a hosted marketplace: a completed cache copy plus its skill index row. */
const simulateGrokBotInstall = async (box: Sandbox, version = '1.2.3'): Promise<string> => {
  const commit = '0401b288f8d5b444bc445ed4c3ac2b94fb24e02c';
  const installPath = join(box.agentData, 'plugins', 'cache', 'scriptedalchemy-plugins', 'grok-fixture', commit);
  await writeJson(join(installPath, '.cursor-plugin', 'plugin.json'), { name: 'grok-fixture', version });
  await writeFile(join(installPath, '.cache-complete'), '');
  await writeJson(join(box.agentData, 'plugin-skills', 'cache.json'), {
    skills: [
      {
        // The index may still spell the legacy sand-data root; only the cache-relative tail identifies the copy.
        installPath: `/home/box/sand-data/plugins/cache/scriptedalchemy-plugins/grok-fixture/${commit}`,
        name: 'talk',
        pluginId: '69001364',
        pluginName: 'grok-fixture',
        pluginVersion: commit,
      },
      { installPath: '/elsewhere', pluginId: '1', pluginName: 'other' },
    ],
  });
  return commit;
};

it('stages the Cursor projection as a Grok Bot marketplace repository with a receipt and honest next steps', async () => {
  const box = await sandbox();
  try {
    const result = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    const repo = join(box.home, '.grokbot', 'agent-bundle', 'marketplaces', 'grok-fixture');
    expect(result).toMatchObject({
      destination: repo,
      host: 'grokbot',
      marketplace: 'grok-fixture-marketplace',
      mode: 'marketplace',
      plugin: 'grok-fixture',
      state: 'staged',
      version: '1.2.3',
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(JSON.parse(await readFile(join(repo, '.cursor-plugin', 'marketplace.json'), 'utf8'))).toEqual({
      metadata: { description: 'Agent Bundle local marketplace for grok-fixture@1.2.3.' },
      name: 'grok-fixture-marketplace',
      owner: { name: 'grok-fixture' },
      plugins: [{ name: 'grok-fixture', source: 'plugins/grok-fixture' }],
    });
    expect(await readFile(join(repo, 'plugins', 'grok-fixture', 'payload.txt'), 'utf8')).toBe('payload\n');
    expect(result.nextSteps?.join('\n')).toContain('hosted Git marketplaces');
    expect(result.nextSteps?.join('\n')).toContain('grokbot://app/v1/plugin/add?id=<plugin id>');
    expect(formatInstallResult(result)).toContain(`Marketplace: grok-fixture-marketplace @ ${result.commit}`);

    const receipt = await readInstallReceiptFile(join(box.home, '.grokbot', 'agent-bundle', 'receipts', 'grok-fixture.marketplace.json'));
    expect(receipt).toMatchObject({
      host: 'grokbot',
      mode: 'marketplace',
      plugin: 'grok-fixture',
      registrations: [{ commit: result.commit, kind: 'grokbot-marketplace-staging', name: 'grok-fixture-marketplace' }],
      scope: 'user',
      version: '1.2.3',
    });
    // Nothing is written into Grok Bot's own plugin cache: registration is server-side.
    await expect(access(join(box.agentData, 'plugins', 'cache', 'grok-fixture-marketplace'))).rejects.toMatchObject({ code: 'ENOENT' });

    const again = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(again).toMatchObject({ commit: result.commit, state: 'already-installed' });
  } finally {
    await box.cleanup();
  }
});

it('refuses a non-user scope and an explicit mode for grokbot', async () => {
  const box = await sandbox();
  try {
    const scoped = await installBundle({ from: box.from, home: box.home, host: 'grokbot', scope: 'project' })
      .catch((error: unknown) => error);
    expect((scoped as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7003', target: 'grokbot' }]);
    const moded = await installBundle({ from: box.from, home: box.home, host: 'grokbot', mode: 'marketplace' })
      .catch((error: unknown) => error);
    expect((moded as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7003', target: 'grokbot' }]);
  } finally {
    await box.cleanup();
  }
});

it('reads the plugin id and installed commit from the Grok Bot cache and skill index', async () => {
  const box = await sandbox();
  try {
    expect(await readGrokBotInventory('grok-fixture', { environment: box.environment, home: box.home }))
      .toEqual({ agentData: box.agentData, entries: [], status: 'available' });
    const commit = await simulateGrokBotInstall(box);
    expect(await readGrokBotInventory('grok-fixture', { environment: box.environment, home: box.home })).toEqual({
      agentData: box.agentData,
      entries: [{
        installPath: join(box.agentData, 'plugins', 'cache', 'scriptedalchemy-plugins', 'grok-fixture', commit),
        manifestVersion: '1.2.3',
        marketplace: 'scriptedalchemy-plugins',
        pluginId: '69001364',
        pluginVersion: commit,
      }],
      status: 'available',
    });
    const missing = await readGrokBotInventory('grok-fixture', { environment: {}, home: box.home });
    // The default candidates include /home/box/agent-data, which exists only on a Grok Bot computer.
    if (missing.status === 'available') expect(missing.agentData).toBe('/home/box/agent-data');
    else expect(missing.reason).toContain('GROK_BOT_AGENT_DATA_DIR');
  } finally {
    await box.cleanup();
  }
});

it('doctor --host grokbot reports the plugin id and version once Grok Bot installed it', async () => {
  const box = await sandbox();
  try {
    const before = await runDoctor({
      endpointDirectory: join(box.home, 'endpoints'),
      environment: box.environment,
      from: box.from,
      home: box.home,
      hosts: ['grokbot'],
    });
    expect(before.hosts.map((host) => host.host)).toEqual(['grokbot']);
    expect(before.hosts[0]?.bundle).toMatchObject({ name: 'grok-fixture', state: 'missing', version: '1.2.3' });
    expect(before.diagnostics.find((entry) => entry.code === 'AB7334')?.message).toContain('is not installed in Grok Bot');

    await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    const staged = await runDoctor({
      endpointDirectory: join(box.home, 'endpoints'),
      environment: box.environment,
      from: box.from,
      home: box.home,
      hosts: ['grokbot'],
    });
    expect(staged.hosts[0]?.bundle?.state).toBe('unregistered');
    expect(staged.hosts[0]?.receipts).toMatchObject([{ plugin: 'grok-fixture', state: 'consistent' }]);

    const commit = await simulateGrokBotInstall(box);
    const installed = await runDoctor({
      endpointDirectory: join(box.home, 'endpoints'),
      environment: box.environment,
      from: box.from,
      home: box.home,
      hosts: ['grokbot'],
    });
    const report = installed.hosts[0];
    expect(report?.probe).toEqual({ evidence: 'directory', status: 'available' });
    expect(report?.bundle).toMatchObject({ pluginId: '69001364', state: 'registered', version: '1.2.3' });
    expect(report?.inventory.findings).toMatchObject([{
      commit,
      marketplace: 'scriptedalchemy-plugins',
      name: 'grok-fixture',
      pluginId: '69001364',
      state: 'registered',
      version: '1.2.3',
    }]);
    const diagnostic = installed.diagnostics.find((entry) => entry.code === 'AB7334');
    expect(diagnostic).toMatchObject({ severity: 'info', target: 'grokbot' });
    expect(diagnostic?.message).toContain(`plugin id 69001364, version 1.2.3, commit ${commit}`);
    const text = formatDoctorReport(installed);
    expect(text).toContain('plugin id: 69001364');
    expect(text).toContain(`installed: grok-fixture@1.2.3 (plugin id 69001364, commit ${commit}, marketplace scriptedalchemy-plugins)`);
  } finally {
    await box.cleanup();
  }
});

it('warns when Grok Bot installed a different version than the bundle', async () => {
  const box = await sandbox();
  try {
    await simulateGrokBotInstall(box, '1.0.0');
    const report = await runDoctor({
      endpointDirectory: join(box.home, 'endpoints'),
      environment: box.environment,
      from: box.from,
      home: box.home,
      hosts: ['grokbot'],
    });
    expect(report.diagnostics.find((entry) => entry.code === 'AB7334')).toMatchObject({ severity: 'warning' });
  } finally {
    await box.cleanup();
  }
});

it('uninstall grokbot removes the receipted staging and names the server-side plugin id to remove by hand', async () => {
  const box = await sandbox();
  try {
    const installed = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    await simulateGrokBotInstall(box);
    const planned = await uninstallBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot', plan: true });
    expect(planned.state).toBe('planned');
    await access(installed.destination ?? '');

    const result = await uninstallBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(result).toMatchObject({ host: 'grokbot', mode: 'marketplace', state: 'uninstalled' });
    expect(result.registrations).toMatchObject([
      { action: 'removed', commit: installed.commit, kind: 'grokbot-marketplace-staging' },
      { action: 'manual', kind: 'grokbot-marketplace-staging' },
    ]);
    expect(result.nextSteps?.[0]).toContain('plugin id 69001364');
    expect(formatUninstallResult(result)).toContain('Uninstalled grok-fixture@1.2.3 for grokbot (marketplace mode)');
    await expect(access(installed.destination ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(box.home, '.grokbot', 'agent-bundle'))).rejects.toMatchObject({ code: 'ENOENT' });

    const again = await uninstallBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    expect(again.state).toBe('not-installed');
  } finally {
    await box.cleanup();
  }
});

it('package-bound installer bins accept grokbot for install, uninstall, and doctor', async () => {
  const box = await sandbox();
  const previous = { data: process.env['GROK_BOT_AGENT_DATA_DIR'], home: process.env['GROK_BOT_HOME'] };
  process.env['GROK_BOT_AGENT_DATA_DIR'] = box.agentData;
  const grokHome = join(box.home, 'custom-grokbot');
  process.env['GROK_BOT_HOME'] = grokHome;
  try {
    let stdout = '';
    const run = (argv: readonly string[]): Promise<number> =>
      runInstallCli(argv, { from: box.from, name: 'fixture-install', stderr: () => undefined, stdout: (text) => { stdout += text; } });
    expect(await run(['install', 'grokbot'])).toBe(0);
    expect(stdout).toContain('Staged grok-fixture@1.2.3 for grokbot (marketplace mode)');
    // GROK_BOT_HOME from the process environment decides where install stages and receipts, and uninstall removes them there.
    const receipt = grokBotReceiptPath(grokHome, 'grok-fixture');
    await access(receipt);
    await access(join(grokHome, 'agent-bundle', 'marketplaces', 'grok-fixture'));
    stdout = '';
    expect(await run(['doctor', '--host', 'grokbot'])).toBe(0);
    expect(stdout).toContain('grokbot: available (directory)');
    stdout = '';
    expect(await run(['uninstall', 'grokbot'])).toBe(0);
    expect(stdout).toContain('Uninstalled grok-fixture@1.2.3 for grokbot');
    await expect(access(receipt)).rejects.toThrow();
  } finally {
    for (const [key, value] of [['GROK_BOT_AGENT_DATA_DIR', previous.data], ['GROK_BOT_HOME', previous.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await box.cleanup();
  }
});

it('resolves GROK_BOT_HOME from the process environment when no environment is passed', () => {
  const previous = process.env['GROK_BOT_HOME'];
  process.env['GROK_BOT_HOME'] = '/tmp/grokbot-home-from-env';
  try {
    expect(grokBotRoot({ home: '/home/someone' })).toBe('/tmp/grokbot-home-from-env');
    expect(grokBotRoot({ environment: {}, home: '/home/someone' })).toBe(join('/home/someone', '.grokbot'));
  } finally {
    if (previous === undefined) delete process.env['GROK_BOT_HOME'];
    else process.env['GROK_BOT_HOME'] = previous;
  }
});

it('rewrites shared Cursor staging diagnostics without --mode recovery advice', () => {
  const git = grokBotStagingMessage(
    'git is required for `--mode marketplace` (Cursor imports marketplaces from Git repositories); install git or use `--mode local`.',
  );
  expect(git).toBe('git is required for the grokbot host (Grok Bot installs plugins from Git marketplaces); install git.');
  const nested = grokBotStagingMessage(
    '`--mode marketplace` refuses bundle-internal Git metadata at "a/.git": git would record it as an empty gitlink and ' +
      'Cursor would import a plugin without files. Stage from a built bundle directory without `.git`, or use `--mode local`.',
  );
  expect(nested).not.toContain('--mode');
  expect(nested).toContain('Grok Bot would import');
  expect(grokBotStagingMessage('Cursor marketplace staging failed: git commit: boom')).toBe('Grok Bot marketplace staging failed: git commit: boom');
});

/** Rewrites the fixture bundle in place, as a rebuild would. */
const rebuild = async (box: Sandbox, version: string, payload: string): Promise<void> => {
  await writeFile(join(box.from, 'payload.txt'), payload);
  await writeJson(join(box.from, '.cursor-plugin/plugin.json'), { name: 'grok-fixture', version });
  await writeInstallFixtureManifest(box.from, { name: 'grok-fixture', version }, [{ host: 'cursor' }]);
};

it('restages a receipt-owned Grok Bot marketplace on same-version drift and on --replace for a new version', async () => {
  const box = await sandbox();
  try {
    const install = (replace?: boolean) => installBundle({
      environment: box.environment, from: box.from, home: box.home, host: 'grokbot', ...(replace === undefined ? {} : { replace }),
    });
    const repo = join(box.home, '.grokbot', 'agent-bundle', 'marketplaces', 'grok-fixture');
    const first = await install();

    await rebuild(box, '1.2.3', 'drifted\n');
    const drift = await install();
    expect(drift).toMatchObject({ previousContentHash: first.contentHash, state: 'replaced', version: '1.2.3' });
    expect(drift.commit).not.toBe(first.commit);
    expect(await readFile(join(repo, 'plugins', 'grok-fixture', 'payload.txt'), 'utf8')).toBe('drifted\n');

    await rebuild(box, '1.3.0', 'next\n');
    const refused = await install().catch((error: unknown) => error);
    expect((refused as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005', target: 'grokbot' }]);
    expect((refused as DiagnosticError).diagnostics[0]?.message).toContain('--replace');
    expect(await readFile(join(repo, 'plugins', 'grok-fixture', 'payload.txt'), 'utf8')).toBe('drifted\n');

    const replaced = await install(true);
    expect(replaced).toMatchObject({ previousContentHash: drift.contentHash, state: 'replaced', version: '1.3.0' });
    expect(await readFile(join(repo, 'plugins', 'grok-fixture', 'payload.txt'), 'utf8')).toBe('next\n');
    const receipt = await readInstallReceiptFile(grokBotReceiptPath(join(box.home, '.grokbot'), 'grok-fixture'));
    expect(receipt).toMatchObject({ registrations: [{ commit: replaced.commit }], version: '1.3.0' });
  } finally {
    await box.cleanup();
  }
});

it('leaves a dirty staged repository for the stager to refuse instead of replacing it', async () => {
  const box = await sandbox();
  try {
    await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot' });
    const repo = join(box.home, '.grokbot', 'agent-bundle', 'marketplaces', 'grok-fixture');
    await writeFile(join(repo, 'local-edit.txt'), 'mine\n');
    await rebuild(box, '1.2.3', 'drifted\n');
    const refused = await installBundle({ environment: box.environment, from: box.from, home: box.home, host: 'grokbot', replace: true })
      .catch((error: unknown) => error);
    expect((refused as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005', target: 'grokbot' }]);
    expect(await readFile(join(repo, 'local-edit.txt'), 'utf8')).toBe('mine\n');
  } finally {
    await box.cleanup();
  }
});
