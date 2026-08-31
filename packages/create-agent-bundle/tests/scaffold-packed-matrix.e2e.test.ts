import { execFile as executeFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, expect, it } from '@rstest/core';

import { installedEnvironment, npmInstallArguments } from '../../agent-bundle/tests/support/shared-pack.ts';
import { cleanupScaffoldFixture, expectCleanValidate, npmRun, scaffoldProject } from './support/scaffold-fixture.ts';

const execFile = promisify(executeFile);

afterAll(cleanupScaffoldFixture);

/**
 * Release-boundary template matrix: the remaining scaffolder templates, each
 * through scaffold, install, check, and validate. Runs in
 * `test:packed:release` (check:release and the nightly CI schedule), not in
 * the per-PR packed pool — the per-PR scaffolder proof is the minimal-template
 * smoke in scaffold-packed.e2e.test.ts. The template tests run concurrently:
 * each scaffolds its own project directory under the shared runner and npm's
 * cache tolerates concurrent installs, so the only shared state is the
 * memoized fixture promise.
 */
it.concurrent('scaffolds the mcp-server template and serves the conventional entry from the artifact', async () => {
  const projectRoot = await scaffoldProject('mcp-server', 'status-plugin', ['--no-install']);
  await execFile('npm', ['install', ...npmInstallArguments], {
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

it.concurrent('scaffolds the cli-tool template with a framework-built bin, lib, and artifact script', async () => {
  const projectRoot = await scaffoldProject('cli-tool', 'greeter', ['--no-install']);
  await execFile('npm', ['install', ...npmInstallArguments], {
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
