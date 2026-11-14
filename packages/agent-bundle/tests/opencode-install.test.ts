import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { runDoctor } from '../src/install/doctor.ts';
import { openCodeInstallLocation } from '../src/install/opencode.ts';
import { installBundle, type InstallCommandRunner } from '../src/install/install.ts';
import { readInstallReceipt } from '../src/install/receipt.ts';
import { uninstallBundle } from '../src/install/uninstall.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';
import { removeTree } from './support/remove-tree.ts';

const pluginName = 'movie-library';

const writeBundle = async (root: string, version: string, marker: string): Promise<void> => {
  await mkdir(join(root, 'mcp'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'index.js'), `export default { id: 'movie-library', async setup() { /* ${marker} */ } };\n`),
    writeFile(join(root, 'package.json'), `${JSON.stringify({ name: pluginName, type: 'module', version, exports: { '.': './index.js' } }, null, 2)}\n`),
    writeFile(join(root, 'mcp', 'library.mjs'), `export const marker = ${JSON.stringify(marker)};\n`),
    writeFile(join(root, 'agent-bundle.mcp.json'), '{"mcpServers":{}}\n'),
  ]);
  await mkdir(join(root, '.opencode'), { recursive: true });
  await writeFile(join(root, '.opencode', 'opencode.json'), '{"$schema":"https://opencode.ai/config.json","plugins":["."]}\n');
  await writeInstallFixtureManifest(root, { name: pluginName, version }, [{ host: 'opencode', mcp: 'agent-bundle.mcp.json' }]);
};

it('honors ambient XDG_CONFIG_HOME for the shared native package location', () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/isolated-native-config';
  try {
    expect(openCodeInstallLocation({ home: '/isolated-home' }, { plugin: 'fixture' }, 'user')).toMatchObject({
      destination: '/isolated-native-config/opencode/plugins/fixture',
      hostRoot: '/isolated-native-config/opencode',
      registration: 'opencode-user-plugin',
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

const forbiddenRunner = (): InstallCommandRunner => ({
  async run() {
    throw new Error('OpenCode directory installation must not invoke a host command.');
  },
});

it('installs, diagnoses, replaces, and uninstalls a receipt-owned native V2 package without touching user config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-install-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const configRoot = join(home, '.config', 'opencode');
  const settings = join(configRoot, 'opencode.json');
  await mkdir(bundle, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await writeFile(settings, '{"model":"keep/me"}\n');
  await writeBundle(bundle, '1.0.0', 'first');
  const destination = join(configRoot, 'plugins', pluginName);

  try {
    const installed = await installBundle({
      commandRunner: forbiddenRunner(),
      environment: {},
      from: bundle,
      home,
      host: 'opencode',
      scope: 'user',
    });
    expect(installed).toMatchObject({
      destination,
      host: 'opencode',
      mode: 'local',
      plugin: pluginName,
      state: 'installed',
      version: '1.0.0',
    });
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('first');
    await expect(readFile(join(destination, 'mcp', 'library.mjs'), 'utf8')).resolves.toContain('first');
    expect(await readInstallReceipt(destination)).toMatchObject({
      files: expect.arrayContaining(['index.js', 'mcp/library.mjs', 'package.json']),
      host: 'opencode',
      registrations: [{ kind: 'opencode-user-plugin' }],
      scope: 'user',
    });

    expect((await installBundle({
      commandRunner: forbiddenRunner(), environment: {}, from: bundle, home, host: 'opencode', scope: 'user',
    }))).toMatchObject({ destination, state: 'already-installed' });

    await mkdir(join(destination, 'state'), { recursive: true });
    await writeFile(join(destination, 'state', 'custom.json'), '{"keep":true}\n');
    await writeFile(join(destination, 'unowned.txt'), 'preserve me\n');
    await writeBundle(bundle, '1.0.0', 'second');
    expect((await installBundle({
      commandRunner: forbiddenRunner(), environment: {}, from: bundle, home, host: 'opencode', scope: 'user',
    })).state).toBe('replaced');
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('second');
    await expect(readFile(join(destination, 'state', 'custom.json'), 'utf8')).resolves.toBe('{"keep":true}\n');
    await expect(readFile(join(destination, 'unowned.txt'), 'utf8')).resolves.toBe('preserve me\n');

    const report = await runDoctor({
      commandRunner: async (request) => ({
        args: request.args,
        exitCode: 0,
        stderr: '',
        signal: null,
        stdout: 'opencode v2.2.6\n',
      }),
      environment: {},
      from: bundle,
      home,
      hosts: ['opencode'],
    });
    expect(report.hosts).toHaveLength(1);
    expect(report.hosts[0]).toMatchObject({
      host: 'opencode',
      probe: { status: 'available', version: '2.2.6' },
      bundle: {
        state: 'installed',
        comparison: { status: 'current' },
        lifecycle: {
          active: { status: 'unavailable' },
          enabled: { status: 'unavailable' },
          placed: { status: 'observed', value: true },
          registered: { status: 'observed', value: true },
          stage: 'registered',
        },
      },
    });

    const planned = await uninstallBundle({
      commandRunner: forbiddenRunner(), environment: {}, from: bundle, home, host: 'opencode', plan: true, scope: 'user',
    });
    expect(planned.state).toBe('planned');
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('second');

    const uninstalled = await uninstallBundle({
      commandRunner: forbiddenRunner(), environment: {}, from: bundle, home, host: 'opencode', scope: 'user',
    });
    expect(uninstalled).toMatchObject({
      registrations: [{ action: 'removed', kind: 'opencode-user-plugin' }],
      state: 'uninstalled',
    });
    await expect(readFile(join(destination, 'index.js'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(destination, 'state', 'custom.json'), 'utf8')).resolves.toBe('{"keep":true}\n');
    await expect(readFile(join(destination, 'unowned.txt'), 'utf8')).resolves.toBe('preserve me\n');
    expect(uninstalled.receipt).toMatchObject({ status: 'remnant' });
    expect(await readInstallReceipt(destination)).toMatchObject({
      files: [],
      registrations: [],
    });

    const reinstalled = await installBundle({
      commandRunner: forbiddenRunner(), environment: {}, from: bundle, home, host: 'opencode', scope: 'user',
    });
    expect(reinstalled.state).toBe('installed');
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('second');
    await expect(readFile(join(destination, 'state', 'custom.json'), 'utf8')).resolves.toBe('{"keep":true}\n');
    await expect(readFile(settings, 'utf8')).resolves.toBe('{"model":"keep/me"}\n');
  } finally {
    await removeTree(root);
  }
}, 30_000);

it('uses XDG user and explicit project roots, and refuses a foreign package directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-roots-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  const projectRoot = join(root, 'project');
  await mkdir(bundle, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeBundle(bundle, '1.0.0', 'roots');

  try {
    const system = await installBundle({
      environment: { XDG_CONFIG_HOME: xdg }, from: bundle, home, host: 'opencode', scope: 'user',
    });
    expect(system.destination).toBe(join(xdg, 'opencode', 'plugins', pluginName));

    const project = await installBundle({
      environment: {}, from: bundle, home, host: 'opencode', projectRoot, scope: 'project',
    });
    expect(project.destination).toBe(join(projectRoot, '.opencode', 'plugins', pluginName));
    expect(await readInstallReceipt(project.destination!)).toMatchObject({
      registrations: [{ kind: 'opencode-project-plugin' }],
      scope: 'project',
    });
    expect((await uninstallBundle({
      environment: {}, from: bundle, home, host: 'opencode', projectRoot, scope: 'project',
    })).state).toBe('uninstalled');

    await writeBundle(bundle, '2.0.0', 'foreign-source');
    await writeFile(join(system.destination!, 'unowned.txt'), 'foreign\n');
    await rm(join(system.destination!, 'agent-bundle.manifest.json'));
    await rm(join(system.destination!, '.agent-bundle-install.json'));
    await expect(installBundle({
      environment: { XDG_CONFIG_HOME: xdg }, from: bundle, home, host: 'opencode', replace: true, scope: 'user',
    })).rejects.toThrow();
    await expect(readFile(join(system.destination!, 'unowned.txt'), 'utf8')).resolves.toBe('foreign\n');
  } finally {
    await removeTree(root);
  }
}, 30_000);

it('reports the drifted alternative instead of letting a healthy scope hide it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-two-scopes-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  const workingDirectory = process.cwd();
  await mkdir(projectRoot, { recursive: true });
  try {
    await writeBundle(bundle, '1.0.0', 'first');
    await installBundle({ environment: {}, from: bundle, home, host: 'opencode', projectRoot, scope: 'project' });
    await installBundle({ environment: {}, from: bundle, home, host: 'opencode', scope: 'user' });
    await writeBundle(bundle, '1.0.0', 'second');
    await installBundle({ environment: {}, from: bundle, home, host: 'opencode', scope: 'user' });
    process.chdir(projectRoot);
    const report = await runDoctor({
      commandRunner: async () => ({ args: ['--version'], exitCode: 0, signal: null, stderr: '', stdout: 'opencode v2.2.6\n' }),
      environment: {},
      from: bundle,
      home,
      hosts: ['opencode'],
    });
    expect(report.hosts[0]?.bundle).toMatchObject({
      state: 'drifted',
      comparison: { status: 'stale' },
    });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'AB7336',
      severity: 'warning',
    }));

    await writeFile(join(projectRoot, '.opencode', 'plugins', pluginName, 'operator-notes.txt'), 'keep this operator note\n');
    await uninstallBundle({
      environment: {}, from: bundle, home, host: 'opencode', projectRoot, scope: 'project',
    });
    const withRemnant = await runDoctor({
      commandRunner: async () => ({ args: ['--version'], exitCode: 0, signal: null, stderr: '', stdout: 'opencode v2.2.6\n' }),
      environment: {},
      from: bundle,
      home,
      hosts: ['opencode'],
    });
    expect(withRemnant.hosts[0]?.bundle).toMatchObject({
      comparison: { status: 'current' },
      state: 'installed',
    });
    expect(withRemnant.diagnostics.filter((entry) => entry.code === 'AB7336')).toEqual([]);
    expect(withRemnant.hosts[0]?.inventory.findings).toContainEqual(expect.objectContaining({
      path: join(projectRoot, '.opencode', 'plugins', pluginName),
      state: 'missing',
      receipt: expect.objectContaining({ scope: 'project' }),
    }));
  } finally {
    process.chdir(workingDirectory);
    await removeTree(root);
  }
}, 30_000);

it('preserves remnant authority for retained state under an explicit purge request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-purge-remnant-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  try {
    await writeBundle(bundle, '1.0.0', 'purge');
    const installed = await installBundle({ environment: {}, from: bundle, home, host: 'opencode', scope: 'user' });
    const destination = join(home, '.config', 'opencode', 'plugins', pluginName);
    expect(installed.destination).toBe(destination);
    await mkdir(join(destination, 'state'), { recursive: true });
    await writeFile(join(destination, 'state', 'retained.json'), '{"retained":true}\n');
    const removed = await uninstallBundle({
      environment: {},
      from: bundle,
      home,
      host: 'opencode',
      purgeData: true,
      confirmPurge: true,
      scope: 'user',
    });
    expect(removed.receipt).toMatchObject({ status: 'remnant' });
    await expect(readFile(join(destination, 'state', 'retained.json'), 'utf8')).resolves.toBe('{"retained":true}\n');
    expect((await uninstallBundle({
      environment: {},
      from: bundle,
      home,
      host: 'opencode',
      purgeData: true,
      confirmPurge: true,
      scope: 'user',
    })).receipt).toMatchObject({ status: 'remnant' });
    expect((await installBundle({
      environment: {}, from: bundle, home, host: 'opencode', scope: 'user',
    })).state).toBe('installed');
  } finally {
    await removeTree(root);
  }
}, 30_000);
