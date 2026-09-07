import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { stableJson } from '../src/core/digest.ts';
import { installBundle, type InstallCommandRunner } from '../src/install/install.ts';
import { readInstallReceipt } from '../src/install/receipt.ts';
import { uninstallBundle } from '../src/install/uninstall.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';

const pluginName = 'amp-install-fixture';

const writeBundle = async (
  root: string,
  version: string,
  marker: string,
  name = pluginName,
): Promise<void> => {
  const plugin = join(root, '.amp', 'plugins', name);
  await mkdir(join(plugin, 'skills', 'review'), { recursive: true });
  await mkdir(join(plugin, 'hooks'), { recursive: true });
  await writeFile(join(plugin, 'index.js'), `export default async function () { /* ${marker} */ }\n`);
  await writeFile(join(plugin, 'hooks', 'hooks-flight.mjs'), `export const marker = ${JSON.stringify(marker)};\n`);
  await writeFile(join(plugin, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code.\n---\n');
  await writeFile(join(root, 'outside.txt'), 'must not be installed\n');
  await writeInstallFixtureManifest(root, { name, version }, [{ host: 'amp' }]);
};

const forbiddenRunner = (): InstallCommandRunner => ({
  async run() {
    throw new Error('Amp directory installation must not invoke a host command.');
  },
});

it('installs, replaces, and uninstalls only the receipt-owned Amp directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-install-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const settings = join(home, '.config', 'amp', 'settings.json');
  await mkdir(bundle, { recursive: true });
  await mkdir(join(home, '.config', 'amp'), { recursive: true });
  await writeFile(settings, '{"amp.plugins.disabled":["amp-install-fixture"]}\n');
  await writeBundle(bundle, '1.0.0', 'first');

  const destination = join(home, '.config', 'amp', 'plugins', pluginName);
  try {
    const installed = await installBundle({
      commandRunner: forbiddenRunner(),
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    });

    expect(installed).toMatchObject({
      destination,
      host: 'amp',
      mode: 'local',
      plugin: pluginName,
      state: 'installed',
      version: '1.0.0',
    });
    expect(installed.nextSteps).toEqual([
      'Open Amp’s command palette with Ctrl+O and run `plugins: reload`.',
      'Run `amp plugins list` in a shell to inspect the installed plugin.',
    ]);
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('first');
    await expect(readFile(join(destination, 'hooks', 'hooks-flight.mjs'), 'utf8')).resolves.toContain('first');
    await expect(readFile(join(destination, 'outside.txt'), 'utf8')).rejects.toThrow();
    expect(await readInstallReceipt(destination)).toMatchObject({
      files: expect.arrayContaining(['hooks/hooks-flight.mjs']),
      host: 'amp',
      mode: 'local',
      plugin: pluginName,
      registrations: [{ kind: 'amp-system-plugin' }],
      scope: 'user',
    });

    const unchanged = await installBundle({
      commandRunner: forbiddenRunner(),
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    });
    expect(unchanged.state).toBe('already-installed');

    await writeFile(join(destination, 'disabled-state.json'), '{"disabled":true}\n');
    await writeBundle(bundle, '1.0.0', 'second');
    const replaced = await installBundle({
      commandRunner: forbiddenRunner(),
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    });
    expect(replaced.state).toBe('replaced');
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('second');
    await expect(readFile(join(destination, 'hooks', 'hooks-flight.mjs'), 'utf8')).resolves.toContain('second');
    await expect(readFile(join(destination, 'disabled-state.json'), 'utf8')).resolves.toBe('{"disabled":true}\n');
    await expect(readFile(settings, 'utf8')).resolves.toBe('{"amp.plugins.disabled":["amp-install-fixture"]}\n');

    const planned = await uninstallBundle({
      commandRunner: forbiddenRunner(),
      from: bundle,
      home,
      host: 'amp',
      plan: true,
      scope: 'user',
    });
    expect(planned.state).toBe('planned');
    expect(planned.removed.directories).not.toContain(destination);
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('second');

    const uninstalled = await uninstallBundle({
      commandRunner: forbiddenRunner(),
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    });
    expect(uninstalled).toMatchObject({
      host: 'amp',
      registrations: [{ action: 'removed', kind: 'amp-system-plugin' }],
      state: 'uninstalled',
    });
    await expect(readFile(join(destination, 'index.js'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(destination, 'hooks', 'hooks-flight.mjs'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(destination, 'skills', 'review', 'SKILL.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(destination, 'disabled-state.json'), 'utf8')).resolves.toBe('{"disabled":true}\n');
    await expect(readFile(settings, 'utf8')).resolves.toBe('{"amp.plugins.disabled":["amp-install-fixture"]}\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('uses the documented XDG system and project plugin roots without touching Amp settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-roots-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  const projectRoot = join(root, 'project');
  await mkdir(bundle, { recursive: true });
  await mkdir(join(projectRoot, '.amp'), { recursive: true });
  await writeFile(join(projectRoot, '.amp', 'settings.json'), '{"trusted":false}\n');
  await writeBundle(bundle, '1.0.0', 'roots');

  try {
    const system = await installBundle({
      environment: { XDG_CONFIG_HOME: xdg },
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    });
    expect(system.destination).toBe(join(xdg, 'amp', 'plugins', pluginName));

    const project = await installBundle({
      from: bundle,
      home,
      host: 'amp',
      projectRoot,
      scope: 'project',
    });
    expect(project.destination).toBe(join(projectRoot, '.amp', 'plugins', pluginName));
    expect(await readInstallReceipt(project.destination!)).toMatchObject({
      registrations: [{ kind: 'amp-project-plugin' }],
      scope: 'project',
    });
    const uninstalled = await uninstallBundle({
      from: bundle,
      home,
      host: 'amp',
      projectRoot,
      scope: 'project',
    });
    expect(uninstalled.state).toBe('uninstalled');
    await expect(readFile(join(projectRoot, '.amp', 'settings.json'), 'utf8')).resolves.toBe('{"trusted":false}\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('installs a mixed-case portable plugin name accepted by the Amp planner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-portable-name-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const name = 'My_Plugin';
  await mkdir(bundle, { recursive: true });
  await writeBundle(bundle, '1.0.0', 'portable', name);

  try {
    const installed = await installBundle({
      commandRunner: forbiddenRunner(),
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    });
    expect(installed.destination).toBe(join(home, '.config', 'amp', 'plugins', name));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects an Amp manifest name that could escape the plugin root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-unsafe-name-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  await mkdir(bundle, { recursive: true });
  await writeBundle(bundle, '1.0.0', 'unsafe');
  const manifestPath = join(bundle, 'agent-bundle.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    application: { name: string };
  };
  manifest.application.name = '../../escape';
  await writeFile(manifestPath, `${stableJson(manifest)}\n`);

  try {
    await expect(installBundle({
      commandRunner: forbiddenRunner(),
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    })).rejects.toThrow('not a safe local plugin name');
    await expect(readFile(join(home, '.config', 'escape', 'index.js'), 'utf8')).rejects.toThrow();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('refuses to replace a foreign Amp directory even with --replace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-foreign-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const destination = join(home, '.config', 'amp', 'plugins', pluginName);
  await mkdir(bundle, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'index.js'), 'export default function foreign() {}\n');
  await writeBundle(bundle, '1.0.0', 'owned');

  try {
    await expect(installBundle({
      from: bundle,
      home,
      host: 'amp',
      replace: true,
      scope: 'user',
    })).rejects.toThrow('foreign install');
    await expect(readFile(join(destination, 'index.js'), 'utf8')).resolves.toContain('foreign');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('refuses a symlinked Amp plugin ancestor before writing outside the host root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-symlink-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const ampRoot = join(home, '.config', 'amp');
  const outside = join(root, 'outside');
  await mkdir(bundle, { recursive: true });
  await mkdir(ampRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(ampRoot, 'plugins'), 'dir');
  await writeBundle(bundle, '1.0.0', 'owned');

  try {
    await expect(installBundle({
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    })).rejects.toThrow('unsupported filesystem entry');
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('refuses modified or unlisted files inside the generated Amp directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-inventory-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const plugin = join(bundle, '.amp', 'plugins', pluginName);
  await mkdir(bundle, { recursive: true });
  await writeBundle(bundle, '1.0.0', 'owned');
  await writeFile(join(plugin, 'unlisted.js'), 'export default "unlisted";\n');

  try {
    await expect(installBundle({
      from: bundle,
      home,
      host: 'amp',
      scope: 'user',
    })).rejects.toThrow('does not match its manifest-owned directory');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
