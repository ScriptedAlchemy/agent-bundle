import { execFile as executeFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();

const installedEnvironment = (): NodeJS.ProcessEnv => {
  const { NODE_PATH: _nodePath, ...environment } = process.env;
  return environment;
};

interface PackedFixture {
  readonly frameworkTarball: string;
  readonly root: string;
  readonly runnerRoot: string;
  readonly scaffolderBin: string;
}

/**
 * Build and `npm pack` agent-bundle and create-agent-bundle once (the
 * packed-consumer mechanism: copy the package, `rslib build --dist-path`
 * into the copy, pack the copy), then install the scaffolder tarball into a
 * clean runner project. Every template test drives the installed bin and
 * pins the framework with `--framework-version file:<tarball>`, so the run
 * never depends on pkg.pr.new.
 */
const packFixture = async (): Promise<PackedFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-e2e-'));
  const pack = async (packageName: string): Promise<string> => {
    const packageRoot = join(workspaceRoot, 'packages', packageName);
    const packedRoot = join(root, `packed-${packageName}`);
    await cp(packageRoot, packedRoot, { recursive: true });
    await execFile(join(workspaceRoot, 'node_modules', '.bin', 'rslib'), [
      'build', '--config', join(packageRoot, 'rslib.config.ts'), '--dist-path', join(packedRoot, 'dist'),
    ], { cwd: workspaceRoot, env: installedEnvironment() });
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', root], {
      cwd: packedRoot,
      env: installedEnvironment(),
    });
    return join(root, (JSON.parse(stdout) as [{ readonly filename: string }])[0].filename);
  };
  const frameworkTarball = await pack('agent-bundle');
  const scaffolderTarball = await pack('create-agent-bundle');

  const runnerRoot = join(root, 'runner');
  await mkdir(runnerRoot, { recursive: true });
  await writeFile(join(runnerRoot, 'package.json'), '{"name":"scaffold-runner","type":"module","private":true}\n');
  await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', scaffolderTarball], {
    cwd: runnerRoot,
    env: installedEnvironment(),
  });
  return {
    frameworkTarball,
    root,
    runnerRoot,
    scaffolderBin: join(runnerRoot, 'node_modules', '.bin', 'create-agent-bundle'),
  };
};

let fixturePromise: Promise<PackedFixture> | undefined;
const fixture = (): Promise<PackedFixture> => {
  fixturePromise ??= packFixture();
  return fixturePromise;
};

afterAll(async () => {
  if (fixturePromise === undefined) return;
  const { root } = await fixture();
  await rm(root, { force: true, recursive: true });
});

const scaffoldProject = async (
  template: string,
  projectName: string,
  extraArguments: readonly string[],
): Promise<string> => {
  const { frameworkTarball, runnerRoot, scaffolderBin } = await fixture();
  await execFile(scaffolderBin, [
    projectName,
    '--template', template,
    '--targets', 'portable,codex,claude',
    '--package-manager', 'npm',
    '--framework-version', `file:${frameworkTarball}`,
    ...extraArguments,
  ], { cwd: runnerRoot, env: installedEnvironment() });
  return join(runnerRoot, projectName);
};

const npmRun = async (projectRoot: string, script: string): Promise<{ readonly stdout: string }> =>
  execFile('npm', ['run', script], { cwd: projectRoot, env: installedEnvironment() });

/** Zero diagnostics — including the informational AB473x migration nudges. */
const expectCleanValidate = async (projectRoot: string): Promise<void> => {
  const cli = join(projectRoot, 'node_modules', '.bin', 'agent-bundle');
  const { stdout } = await execFile(cli, ['validate', '--json', '--root', projectRoot], {
    cwd: projectRoot,
    env: installedEnvironment(),
  });
  const validated = JSON.parse(stdout) as { readonly diagnostics: readonly unknown[] };
  expect(validated.diagnostics).toEqual([]);
};

it('scaffolds the minimal template, auto-installs, and passes its own check', async () => {
  // No --no-install: this run covers the scaffolder-driven `npm install` path.
  const projectRoot = await scaffoldProject('minimal', 'minimal-project', []);

  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
    readonly devDependencies: Record<string, string>;
    readonly name: string;
  };
  expect(manifest.name).toBe('minimal-project');
  expect(manifest.devDependencies['agent-bundle']).toMatch(/^file:.*\.tgz$/u);
  await expect(readFile(join(projectRoot, '.gitignore'), 'utf8')).resolves.toContain('node_modules/');

  await npmRun(projectRoot, 'check');
  await expectCleanValidate(projectRoot);
  await expect(readFile(join(projectRoot, 'artifact', 'portable', 'skills', 'getting-started', 'SKILL.md'), 'utf8'))
    .resolves.toContain('# Getting started');
}, 600_000);

it('scaffolds the mcp-server template and serves the conventional entry from the artifact', async () => {
  const projectRoot = await scaffoldProject('mcp-server', 'status-plugin', ['--no-install']);
  await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: projectRoot,
    env: installedEnvironment(),
  });

  await npmRun(projectRoot, 'check');
  await expectCleanValidate(projectRoot);

  const artifact = join(projectRoot, 'artifact');
  const manifest = JSON.parse(await readFile(join(artifact, 'portable', 'mcp.json'), 'utf8')) as {
    readonly mcpServers: { readonly status: { readonly args: readonly [string, ...string[]] } };
  };
  const entry = join(artifact, 'portable', manifest.mcpServers.status.args[0]);
  // The factory export was wrapped in the framework stdio lifecycle shell.
  await expect(readFile(entry, 'utf8')).resolves.toContain('stdio heartbeat');

  const cli = join(projectRoot, 'node_modules', '.bin', 'agent-bundle');
  const { stdout: listed } = await execFile(cli, [
    'mcp', 'list', '--json', '--root', projectRoot, '--artifact', artifact, '--target', 'portable', '--server', 'status',
  ], { cwd: projectRoot, env: installedEnvironment() });
  expect(JSON.parse(listed)).toMatchObject({ tools: [{ name: 'report-status' }] });
  const { stdout: invoked } = await execFile(cli, [
    'mcp', 'invoke', '--json', '--root', projectRoot, '--artifact', artifact, '--target', 'portable',
    '--server', 'status', '--tool', 'report-status', '--input', '{"service":"docs"}',
  ], { cwd: projectRoot, env: installedEnvironment() });
  expect(JSON.parse(invoked)).toMatchObject({
    result: {
      content: [{ text: 'docs is ready.', type: 'text' }],
      structuredContent: { service: 'docs', status: 'healthy' },
    },
  });
}, 600_000);

it('scaffolds the cli-tool template with a framework-built bin, lib, and artifact script', async () => {
  const projectRoot = await scaffoldProject('cli-tool', 'greeter', ['--no-install']);
  await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: projectRoot,
    env: installedEnvironment(),
  });

  await npmRun(projectRoot, 'check');
  await expectCleanValidate(projectRoot);

  // The src/cli.ts convention produced the executable package bin.
  const bin = join(projectRoot, 'dist', 'bin', 'greeter.js');
  expect((await stat(bin)).mode & 0o111).not.toBe(0);
  expect((await readFile(bin, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
  await expect(execFile(bin, ['World'], { cwd: projectRoot, env: installedEnvironment() }))
    .resolves.toMatchObject({ stdout: 'Hello, World!\n' });

  // The src/index.ts convention produced the library export with declarations.
  const library = await import(pathToFileURL(join(projectRoot, 'dist', 'index.js')).href) as {
    readonly greet: (name: string) => { readonly message: string };
  };
  expect(library.greet('World').message).toBe('Hello, World!');
  await expect(readFile(join(projectRoot, 'dist', 'index.d.ts'), 'utf8')).resolves.toContain('Greeting');

  // The same CLI also shipped inside the host artifact as a script.
  await expect(execFile(process.execPath, [
    join(projectRoot, 'artifact', 'portable', 'scripts', 'greeter.mjs'), 'World',
  ], { cwd: projectRoot, env: installedEnvironment() })).resolves.toMatchObject({ stdout: 'Hello, World!\n' });
}, 600_000);
