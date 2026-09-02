import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';

const execFile = promisify(executeFile);
const roots: string[] = [];
const workspaceNodeModules = join(process.cwd(), 'node_modules');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixture = async (options: {
  readonly bin?: false | string;
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
          : [`  bin: { ${JSON.stringify(options.bin)}: './src/cli.ts' },`]),
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
  const root = await fixture({ bin: 'installer-fixture', target: 'cursor' });
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
  expect(help.stdout).toContain('install <host> [--scope <scope>] [--json]');
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
  expect(JSON.parse(installed.stdout)).toMatchObject({
    host: 'cursor',
    plugin: 'installer-fixture',
    state: 'installed',
    version: '1.2.3',
  });
  await expect(stat(join(home, '.cursor', 'plugins', 'local', 'installer-fixture'))).resolves.toBeDefined();
}, 120_000);

it('uses the plugin name when free and skips portable-only artifacts', async () => {
  const cursorRoot = await fixture({ bin: false, target: 'cursor' });
  const cursor = await build({ output: 'host-packs', packageOutputs: true, root: cursorRoot });
  expect(cursor.packageBuild?.files.map((file) => file.path)).toContain('bin/installer-fixture.js');

  const portableRoot = await fixture({ bin: false, target: 'portable' });
  const portable = await build({ output: 'host-packs', packageOutputs: true, root: portableRoot });
  expect(portable.packageBuild?.files.map((file) => file.path))
    .not.toContain('bin/installer-fixture.js');

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
