import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, expect, it } from '@rstest/core';

import { installedEnvironment, npmInstallArguments, packOutputFromJson } from '../../agent-bundle/tests/support/shared-pack.ts';
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

  const checked = await npmRun(projectRoot, 'check');
  await expectCleanValidate(projectRoot);
  await npmRun(projectRoot, 'prepack');

  // The template's own harness pools ran inside `check`, and they are asserted
  // positively — a silent `check` would also pass if the pools were dropped or
  // matched no files. Each pool names the proof level it carries.
  expect(checked).toContain('tests/route-unit/report-status.test.ts');
  expect(checked).toContain('tests/projection/mcp-in-memory.test.ts');
  // The route-unit pool renders through the framework's own generated setup,
  // resolved from the packed tarball's `agent-bundle/rstest` export.
  const routes = await npmRun(projectRoot, 'test:routes');
  expect(routes).toContain('renders a known service into a final Agent Document');
  expect(routes).toContain('"failedTests": 0');
  const projection = await npmRun(projectRoot, 'test:projection');
  expect(projection).toContain('projects the rendered document into the protocol result the server returns');
  expect(projection).toContain('"failedTests": 0');

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

  // This template ships no framework test pool on purpose: its CLI is a
  // config-declared script bundle rather than a compiled route, so there is
  // nothing for the route-unit or cli-dispatch levels to address (README:
  // "Tests"). What `check` does run is asserted rather than assumed.
  const checked = await npmRun(projectRoot, 'check');
  expect(checked).toContain('tests/cli.test.ts');
  await expectCleanValidate(projectRoot);
  await npmRun(projectRoot, 'prepack');

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

  const packDestination = await mkdtemp(join(tmpdir(), 'create-agent-bundle-cli-pack-'));
  try {
    const { stdout } = await execFile('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', packDestination,
    ], { cwd: projectRoot, env: installedEnvironment() });
    // packOutputFromJson handles both npm pack --json shapes (array and
    // package-keyed object), unlike a bare array destructure.
    const packedPaths = packOutputFromJson(stdout).files.map((file) => file.path);
    expect(packedPaths).toContain('artifact/agent-bundle.manifest.json');
    expect(packedPaths).toContain('artifact/portable/plugin.json');
    expect(packedPaths).toContain('artifact/codex/.codex-plugin/plugin.json');
    expect(packedPaths).toContain('artifact/claude/.claude-plugin/plugin.json');
    expect(packedPaths).toContain('dist/bin/greeter-install.js');
  } finally {
    await rm(packDestination, { force: true, recursive: true });
  }
}, 600_000);
