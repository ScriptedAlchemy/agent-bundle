import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, expect, it } from '@rstest/core';

import { installedEnvironment, packOutputFromJson } from '../../agent-bundle/tests/support/shared-pack.ts';
import {
  cleanupScaffoldFixture,
  expectCleanValidate,
  expectPassedPool,
  installScaffoldedProject,
  npmRun,
  scaffoldProject,
} from './support/scaffold-fixture.ts';

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
  await installScaffoldedProject(projectRoot);

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
  await expectPassedPool(projectRoot, 'test:routes', ['renders a known service into a final Agent Document']);
  await expectPassedPool(projectRoot, 'test:projection', [
    'projects the rendered document into the protocol result the server returns',
  ]);

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

it.concurrent('scaffolds the cli-tool template with a routed bin, lib, and artifact script', async () => {
  const projectRoot = await scaffoldProject('cli-tool', 'greeter', ['--no-install']);
  await installScaffoldedProject(projectRoot);

  // The template's own harness pool ran inside `check`, and it is asserted
  // positively — a silent `check` would also pass if the pool were dropped or
  // matched no files. Each pool names the proof level it carries.
  const checked = await npmRun(projectRoot, 'check');
  expect(checked).toContain('tests/greet.test.ts');
  expect(checked).toContain('tests/projection/cli-dispatch.test.ts');
  expect(checked).toContain('tests/projection/script-dispatch.test.ts');
  await expectCleanValidate(projectRoot);
  await npmRun(projectRoot, 'prepack');
  // The projection pool dispatches through the framework's own generated
  // setup, resolved from the packed tarball's `agent-bundle/rstest` export.
  await expectPassedPool(projectRoot, 'test:projection', [
    'greets through the routed CLI shell and prints one canonical JSON line',
    'greets through the main process envelope',
  ]);

  // The src/cli/** convention produced the routed executable package bin:
  // generated help, the compiled argv grammar, and one canonical JSON line.
  const bin = join(projectRoot, 'dist', 'bin', 'greeter.js');
  expect((await stat(bin)).mode & 0o111).not.toBe(0);
  expect((await readFile(bin, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
  const environment = installedEnvironment();
  const help = await execFile(bin, ['--help'], { cwd: projectRoot, env: environment });
  expect(help.stdout).toContain('greeter 0.1.0');
  expect(help.stdout).toContain('greet');
  await expect(execFile(bin, ['greet', 'World'], { cwd: projectRoot, env: environment }))
    .resolves.toMatchObject({ stdout: '{"message":"Hello, World!","name":"World"}\n' });
  await expect(execFile(bin, ['greet', 'World', '--shout'], { cwd: projectRoot, env: environment }))
    .resolves.toMatchObject({ stdout: '{"message":"HELLO, WORLD!","name":"World"}\n' });
  await expect(execFile(bin, ['greet'], { cwd: projectRoot, env: environment }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Missing required argument: <name>.') });

  // The src/index.ts convention produced the library export with declarations.
  const library = await import(pathToFileURL(join(projectRoot, 'dist', 'index.js')).href) as {
    readonly greet: (name: string) => { readonly message: string };
  };
  expect(library.greet('World').message).toBe('Hello, World!');
  await expect(readFile(join(projectRoot, 'dist', 'index.d.ts'), 'utf8')).resolves.toContain('Greeting');

  // The conventional plain script shipped inside the host artifact with the
  // framework process envelope around its `main` export.
  const script = join(projectRoot, 'artifact', 'portable', 'scripts', 'hello.mjs');
  await expect(execFile(process.execPath, [script, 'World'], { cwd: projectRoot, env: environment }))
    .resolves.toMatchObject({ stdout: 'Hello, World!\n' });
  await expect(execFile(process.execPath, [script], { cwd: projectRoot, env: environment }))
    .rejects.toMatchObject({ code: 2, stderr: 'Usage: hello <name>\n' });

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
