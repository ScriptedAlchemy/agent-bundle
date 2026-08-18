import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');

const releaseEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, NODE_ENV: 'production' });

it('ships repository and support metadata that matches the verified origin', async () => {
  const tarballRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-package-metadata-'));

  try {
    const { stdout } = await execFile('npm', [
      'pack',
      '--json',
      '--pack-destination',
      tarballRoot,
    ], { cwd: packageRoot, env: releaseEnvironment() });
    const [{ filename }] = JSON.parse(stdout) as Array<{ readonly filename: string }>;
    await execFile('tar', ['--extract', '--file', join(tarballRoot, filename), '--directory', tarballRoot]);
    const manifest = JSON.parse(await readFile(join(tarballRoot, 'package', 'package.json'), 'utf8')) as {
      readonly bugs?: { readonly url?: string };
      readonly description?: string;
      readonly homepage?: string;
      readonly keywords?: readonly string[];
      readonly repository?: { readonly type?: string; readonly url?: string };
    };

    expect(manifest).toMatchObject({
      bugs: { url: 'https://github.com/ScriptedAlchemy/agent-bundle/issues' },
      description: 'Compile a typed Agent Bundle configuration into portable, Codex, and Claude Code artifacts.',
      homepage: 'https://github.com/ScriptedAlchemy/agent-bundle#readme',
      repository: { type: 'git', url: 'git+https://github.com/ScriptedAlchemy/agent-bundle.git' },
    });
    expect(manifest.keywords).toEqual(expect.arrayContaining(['agent', 'claude-code', 'codex', 'mcp']));
  } finally {
    await rm(tarballRoot, { force: true, recursive: true });
  }
});

it('runs a release pack dry run with the CLI in its tarball', async () => {
  const { stdout } = await execFile('npm', ['run', 'pack:dry-run'], {
    cwd: workspaceRoot,
    env: releaseEnvironment(),
  });

  expect(stdout).toContain('agent-bundle-0.1.0.tgz');
  expect(stdout).toContain('dist/cli.js');
}, 120_000);

it('packs generated Workbench legal companion files', async () => {
  const tarballRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-release-audit-'));

  try {
    await execFile('npm', ['run', 'build'], { cwd: workspaceRoot, env: releaseEnvironment() });
    const { stdout } = await execFile('npm', [
      'pack',
      '--json',
      '--pack-destination',
      tarballRoot,
    ], { cwd: packageRoot, env: releaseEnvironment() });
    const [{ files }] = JSON.parse(stdout) as Array<{ readonly files: readonly { readonly path: string }[] }>;

    expect(files.map((file) => file.path)).toContainEqual(
      expect.stringMatching(/^dist\/workbench\/.*\.LICENSE\.txt$/u),
    );
  } finally {
    await rm(tarballRoot, { force: true, recursive: true });
  }
}, 120_000);

it('installs public entrypoints and an externally resolved CLI for production consumers', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-release-consumer-'));
  const tarballRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-release-tarball-'));

  try {
    await execFile('npm', ['run', 'build'], { cwd: workspaceRoot, env: releaseEnvironment() });
    const { stdout: packed } = await execFile('npm', [
      'pack',
      '--json',
      '--pack-destination',
      tarballRoot,
    ], { cwd: packageRoot, env: releaseEnvironment() });
    const [{ filename }] = JSON.parse(packed) as Array<{ readonly filename: string }>;
    const tarball = join(tarballRoot, filename);
    await writeFile(join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
    await execFile('npm', [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ], { cwd: consumerRoot, env: releaseEnvironment() });

    const installedPackageRoot = await realpath(join(consumerRoot, 'node_modules', 'agent-bundle'));
    expect(installedPackageRoot.startsWith(workspaceRoot)).toBe(false);
    const manifest = JSON.parse(await readFile(join(installedPackageRoot, 'package.json'), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.dependencies?.commander).toBe('15.0.0');
    await expect(execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      "await Promise.all(['agent-bundle', 'agent-bundle/api', 'agent-bundle/config', 'agent-bundle/eval'].map((specifier) => import(specifier)));",
    ], { cwd: consumerRoot, env: releaseEnvironment() })).resolves.toMatchObject({ stderr: '', stdout: '' });
    const cli = join(consumerRoot, 'node_modules', '.bin', 'agent-bundle');
    await expect(execFile(cli, ['--help'], { cwd: consumerRoot, env: releaseEnvironment() })).resolves.toMatchObject({
      stderr: '',
      stdout: expect.stringContaining('Usage: agent-bundle'),
    });
    await rm(join(consumerRoot, 'node_modules', 'commander'), { force: true, recursive: true });
    await expect(execFile(cli, ['--help'], { cwd: consumerRoot, env: releaseEnvironment() })).rejects.toThrow();
  } finally {
    await Promise.all([
      rm(consumerRoot, { force: true, recursive: true }),
      rm(tarballRoot, { force: true, recursive: true }),
    ]);
  }
}, 120_000);
