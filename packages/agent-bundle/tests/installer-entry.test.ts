import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { installReceiptFile } from '../src/install/receipt.ts';
import { installBundle } from '../src/install/install.ts';

const execFile = promisify(executeFile);
const roots: string[] = [];
const workspaceNodeModules = join(process.cwd(), 'node_modules');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixture = async (options: {
  readonly author?: string;
  readonly bin?: false | readonly string[];
  readonly target: 'cursor' | 'plugin' | 'portable';
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-installer-entry-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await symlink(workspaceNodeModules, join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'installer-fixture',
      type: 'module',
      version: '1.2.3',
    })),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      ...(options.bin === undefined
        ? []
        : options.bin === false
          ? ['  bin: false,']
          : [`  bin: { ${options.bin.map((name) => `${JSON.stringify(name)}: './src/cli.ts'`).join(', ')} },`]),
      ...(options.author === undefined ? [] : [`  cursor: { author: { name: ${JSON.stringify(options.author)} } },`]),
      "  lib: './src/index.ts',",
      "  plugin: { name: 'installer-fixture' },",
      `  targets: [${JSON.stringify(options.target)}],`,
      '};',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'cli.ts'), 'export const main = async () => 0;\n'),
    writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n'),
  ]);
  return root;
};

const run = async (
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }> => {
  try {
    const result = await execFile(executable, [...args], options);
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const failure = error as { readonly code?: number; readonly stderr?: string; readonly stdout?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stderr: failure.stderr ?? '',
      stdout: failure.stdout ?? '',
    };
  }
};

it('builds a package-relative installer with fallback naming and built-host argv validation', async () => {
  const root = await fixture({ bin: ['installer-fixture'], target: 'cursor' });
  const result = await build({
    output: 'nested/non-default-host-packs',
    packageOutputs: true,
    root,
  });
  const installer = join(root, 'dist', 'bin', 'installer-fixture-install.js');

  expect(result.packageBuild?.files.map((file) => file.path)).toContain('bin/installer-fixture-install.js');
  expect((await stat(installer)).mode & 0o111).not.toBe(0);
  expect(await readFile(installer, 'utf8')).not.toMatch(/from\s*['"]agent-bundle/u);

  const help = await run(installer, [], { cwd: tmpdir() });
  expect(help).toMatchObject({ code: 0, stderr: '' });
  expect(help.stdout).toContain('install <host> [--scope <scope>] [--mode local|marketplace] [--replace|--force] [--json]');
  expect(help.stdout).toContain('uninstall <host> [--scope <scope>] [--mode local|marketplace] [--keep-data | --purge-data --confirm-purge] [--force] [--plan] [--json]');
  expect(help.stdout).toContain('cursor');
  expect(help.stdout).not.toContain('claude');

  const rejected = await run(installer, ['install', 'claude'], { cwd: tmpdir() });
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain('claude');
  expect(rejected.stderr).toContain('cursor');

  const artifactRoot = join(root, 'nested', 'non-default-host-packs');
  const hiddenArtifact = `${artifactRoot}-hidden`;
  await rename(artifactRoot, hiddenArtifact);
  const missing = await run(installer, ['install', 'cursor'], { cwd: tmpdir() });
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('Package artifact root is missing');
  expect(missing.stderr).toContain('must ship its generated artifact directory');
  await rename(hiddenArtifact, artifactRoot);

  const home = join(root, 'home');
  await mkdir(join(home, '.cursor'), { recursive: true });
  const installed = await run(installer, ['install', 'cursor', '--json'], {
    cwd: tmpdir(),
    env: { ...process.env, HOME: home },
  });
  expect(installed).toMatchObject({ code: 0, stderr: '' });
  const installedDocument = JSON.parse(installed.stdout) as { readonly contentHash?: string };
  expect(installedDocument).toMatchObject({
    contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    host: 'cursor',
    plugin: 'installer-fixture',
    state: 'installed',
    version: '1.2.3',
  });
  const destination = join(home, '.cursor', 'plugins', 'local', 'installer-fixture');
  await expect(stat(destination)).resolves.toBeDefined();
  await expect(stat(join(destination, installReceiptFile))).resolves.toBeDefined();

  // Both replace spellings parse; an identical artifact stays a no-op even when forced.
  for (const flag of ['--replace', '--force']) {
    const noop = await run(installer, ['install', 'cursor', flag, '--json'], {
      cwd: tmpdir(),
      env: { ...process.env, HOME: home },
    });
    expect(noop, flag).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(noop.stdout), flag).toMatchObject({ contentHash: installedDocument.contentHash, state: 'already-installed' });
  }

  // Same-version content drift of the receipt-managed copy is replaced without a flag.
  await writeFile(join(destination, 'INSTALL.md'), '# stale\n');
  const replaced = await run(installer, ['install', 'cursor'], { cwd: tmpdir(), env: { ...process.env, HOME: home } });
  expect(replaced).toMatchObject({ code: 0, stderr: '' });
  expect(replaced.stdout).toMatch(/^Replaced installer-fixture@1\.2\.3 for cursor \(local mode\) at .* \(content [0-9a-f]{12} -> [0-9a-f]{12}\)\n$/u);

  const unknown = await run(installer, ['install', 'cursor', '--overwrite'], { cwd: tmpdir() });
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('Unknown installer argument "--overwrite"');

  const staged = await run(installer, ['install', 'cursor', '--mode', 'marketplace', '--json'], {
    cwd: tmpdir(),
    env: { ...process.env, HOME: home },
  });
  expect(staged).toMatchObject({ code: 0, stderr: '' });
  const repository = join(home, '.cursor', 'agent-bundle', 'marketplaces', 'installer-fixture');
  expect(JSON.parse(staged.stdout)).toMatchObject({
    commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
    destination: repository,
    marketplace: 'installer-fixture-marketplace',
    mode: 'marketplace',
    state: 'staged',
  });
  await expect(stat(join(repository, '.cursor-plugin', 'marketplace.json'))).resolves.toBeDefined();
  await expect(stat(join(repository, 'plugins', 'installer-fixture', '.cursor-plugin', 'plugin.json'))).resolves.toBeDefined();

  const badMode = await run(installer, ['install', 'cursor', '--mode', 'remote'], { cwd: tmpdir() });
  expect(badMode.code).toBe(1);
  expect(badMode.stderr).toContain('Install mode must be local or marketplace.');

  // The same bin uninstalls: --plan is a no-op that names every path, the real run consumes the receipt and
  // leaves nothing of the local copy behind, and --purge-data is refused without --confirm-purge.
  const env = { ...process.env, HOME: home };
  const plan = await run(installer, ['uninstall', 'cursor', '--plan', '--json'], { cwd: tmpdir(), env });
  expect(plan).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(plan.stdout)).toMatchObject({
    destination,
    mode: 'local',
    receipt: { status: 'consumed' },
    state: 'planned',
  });
  await expect(stat(join(destination, installReceiptFile))).resolves.toBeDefined();
  const unconfirmed = await run(installer, ['uninstall', 'cursor', '--purge-data'], { cwd: tmpdir(), env });
  expect(unconfirmed.code).toBe(1);
  expect(unconfirmed.stderr).toContain('AB7008');
  const uninstalled = await run(installer, ['uninstall', 'cursor'], { cwd: tmpdir(), env });
  expect(uninstalled).toMatchObject({ code: 0, stderr: '' });
  expect(uninstalled.stdout).toMatch(/^Uninstalled installer-fixture@1\.2\.3 for cursor \(local mode\) at /u);
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  const again = await run(installer, ['uninstall', 'cursor', '--json'], { cwd: tmpdir(), env });
  expect(JSON.parse(again.stdout)).toMatchObject({ state: 'not-installed' });
  // Marketplace-mode staging from earlier in this test is removed the same way.
  const marketplaceGone = await run(installer, ['uninstall', 'cursor', '--mode', 'marketplace', '--json'], { cwd: tmpdir(), env });
  expect(marketplaceGone).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(marketplaceGone.stdout)).toMatchObject({ mode: 'marketplace', state: 'uninstalled' });
  await expect(stat(repository)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(home, '.cursor', 'agent-bundle'))).rejects.toMatchObject({ code: 'ENOENT' });
  const unknownVerbFlag = await run(installer, ['install', 'cursor', '--plan'], { cwd: tmpdir(), env });
  expect(unknownVerbFlag.code).toBe(1);
  expect(unknownVerbFlag.stderr).toContain('Unknown installer argument "--plan"');
}, 120_000);

it('chooses an unused installer name when both primary candidates are bins', async () => {
  const root = await fixture({
    bin: ['installer-fixture', 'installer-fixture-install'],
    target: 'cursor',
  });
  const result = await build({ output: 'host-packs', packageOutputs: true, root });

  expect(result.packageBuild?.files.map((file) => file.path)).toEqual(expect.arrayContaining([
    'bin/installer-fixture.js',
    'bin/installer-fixture-install.js',
    'bin/installer-fixture-install-2.js',
  ]));
  const help = await run(join(root, 'dist', 'bin', 'installer-fixture-install-2.js'), ['--help'], { cwd: tmpdir() });
  expect(help).toMatchObject({ code: 0, stderr: '' });
}, 120_000);

it('handles installer help when the project path contains a percent sign', async () => {
  const originalRoot = await fixture({ bin: ['installer-fixture'], target: 'cursor' });
  const root = `${originalRoot}%build`;
  await rename(originalRoot, root);
  roots.splice(roots.indexOf(originalRoot), 1, root);

  await build({ output: 'host-packs', packageOutputs: true, root });
  const help = await run(join(root, 'dist', 'bin', 'installer-fixture-install.js'), ['--help'], { cwd: tmpdir() });

  expect(help).toMatchObject({ code: 0, stderr: '' });
  expect(help.stdout).toContain('install <host> [--scope <scope>] [--mode local|marketplace] [--replace|--force] [--json]');
}, 120_000);

it('uses the plugin name when free and skips portable-only artifacts', async () => {
  const cursorRoot = await fixture({ author: 'Fixture Owner', bin: false, target: 'cursor' });
  const cursor = await build({ output: 'host-packs', packageOutputs: true, root: cursorRoot });
  expect(cursor.packageBuild?.files.map((file) => file.path)).toContain('bin/installer-fixture.js');

  const portableRoot = await fixture({ bin: false, target: 'portable' });
  const portable = await build({ output: 'host-packs', packageOutputs: true, root: portableRoot });
  expect(portable.packageBuild?.files.map((file) => file.path))
    .not.toContain('bin/installer-fixture.js');
  // The Agent Plugins pack has no .cursor-plugin manifest, so its install.mjs must refuse marketplace mode.
  const portableHome = join(portableRoot, 'home');
  await mkdir(join(portableHome, '.cursor'), { recursive: true });
  const portableMarketplace = await run(
    process.execPath,
    [join(portableRoot, 'host-packs', 'portable', 'install.mjs'), '--mode', 'marketplace'],
    { cwd: tmpdir(), env: { ...process.env, HOME: portableHome } },
  );
  expect(portableMarketplace.code).toBe(1);
  expect(portableMarketplace.stderr).toContain('--mode marketplace requires a Cursor Plugin');
  await expect(stat(join(portableHome, '.cursor', 'agent-bundle'))).rejects.toMatchObject({ code: 'ENOENT' });

  // A bundle carrying nested Git metadata would be committed as an empty gitlink; the emitted installer refuses it.
  const cursorHome = join(cursorRoot, 'home');
  await mkdir(join(cursorHome, '.cursor'), { recursive: true });
  await mkdir(join(cursorRoot, 'host-packs', 'cursor', 'vendor', '.git'), { recursive: true });
  const nestedGit = await run(
    process.execPath,
    [join(cursorRoot, 'host-packs', 'cursor', 'install.mjs'), '--mode', 'marketplace'],
    { cwd: tmpdir(), env: { ...process.env, HOME: cursorHome } },
  );
  expect(nestedGit.code).toBe(1);
  expect(nestedGit.stderr).toContain('refuses bundle-internal Git metadata at "vendor/.git"');
  await expect(stat(join(cursorHome, '.cursor', 'agent-bundle'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(join(cursorRoot, 'host-packs', 'cursor', 'vendor'), { recursive: true });

  // The emitted install.mjs and `agent-bundle install cursor --mode marketplace` derive owner/description from the
  // same emitted manifest (authored cursor.author here), so staging with one and rerunning the other is idempotent.
  const stagedByScript = await run(
    process.execPath,
    [join(cursorRoot, 'host-packs', 'cursor', 'install.mjs'), '--mode', 'marketplace'],
    { cwd: tmpdir(), env: { ...process.env, HOME: cursorHome } },
  );
  expect(stagedByScript).toMatchObject({ code: 0, stderr: '' });
  const stagedManifest = JSON.parse(await readFile(
    join(cursorHome, '.cursor', 'agent-bundle', 'marketplaces', 'installer-fixture', '.cursor-plugin', 'marketplace.json'),
    'utf8',
  ));
  expect(stagedManifest.owner).toEqual({ name: 'Fixture Owner' });
  const rerunByCli = await installBundle({
    from: join(cursorRoot, 'host-packs', 'cursor'),
    home: cursorHome,
    host: 'cursor',
    mode: 'marketplace',
  });
  expect(rerunByCli).toMatchObject({ mode: 'marketplace', state: 'already-installed' });

  const pluginRoot = await fixture({ bin: false, target: 'plugin' });
  const plugin = await build({ output: 'host-packs', packageOutputs: true, root: pluginRoot });
  const pluginInstaller = join(pluginRoot, 'dist', 'bin', 'installer-fixture.js');
  expect(plugin.packageBuild?.files.map((file) => file.path)).toContain('bin/installer-fixture.js');
  const help = await run(pluginInstaller, ['--help'], { cwd: tmpdir() });
  expect(help.stdout).toContain('claude, codex, cursor');
  const home = join(pluginRoot, 'home');
  await mkdir(join(home, '.cursor'), { recursive: true });
  const installed = await run(pluginInstaller, ['install', 'cursor', '--json'], {
    cwd: tmpdir(),
    env: { ...process.env, HOME: home },
  });
  expect(installed).toMatchObject({ code: 0, stderr: '' });
}, 120_000);
