import { execFile as executeFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { prepack } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import type { Diagnostic } from '../src/core/diagnostics.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import {
  packInventoryDiagnostics,
  packOutputFromJson,
  type PackOutput,
} from '../src/build/pack-inventory.ts';

const execFile = promisify(executeFile);
const workspaceNodeModules = join(process.cwd(), 'node_modules');
let cleanupRoot: string;
let projectRoot: string;
let result: Awaited<ReturnType<typeof prepack>>;
let payloadPath: string;
let payloadBytes: string;

beforeAll(async () => {
  cleanupRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-prepack-'));
  projectRoot = join(cleanupRoot, 'project');
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await symlink(workspaceNodeModules, join(projectRoot, 'node_modules'), 'dir');
  await Promise.all([
    writeFile(join(projectRoot, 'package.json'), `${JSON.stringify({
      bin: { 'installer-fixture': './dist/bin/installer-fixture.js' },
      files: ['dist', 'host-packs', 'README.md'],
      name: 'installer-fixture',
      type: 'module',
      version: '1.2.3',
    }, null, 2)}\n`),
    writeFile(join(projectRoot, 'README.md'), '# Installer fixture\n'),
    writeFile(join(projectRoot, 'agent-bundle.config.ts'), [
      'export default {',
      '  bin: false,',
      "  lib: './src/index.ts',",
      "  output: { distPath: 'host-packs' },",
      "  plugin: { name: 'installer-fixture' },",
      "  targets: ['cursor'],",
      '};',
      '',
    ].join('\n')),
    writeFile(join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n'),
  ]);
  result = await prepack({ root: projectRoot });
  payloadPath = join(projectRoot, 'host-packs', 'cursor', 'INSTALL.md');
  payloadBytes = await readFile(payloadPath, 'utf8');
});

afterAll(async () => {
  await rm(cleanupRoot, { force: true, recursive: true });
});

const diagnostics = (packOutput: PackOutput = result.pack): Promise<readonly Diagnostic[]> =>
  packInventoryDiagnostics({
    artifactRoot: result.build.build.outputRoot,
    model: result.build.model,
    packageBuild: result.build.packageBuild!,
    packOutput,
    projectRoot,
  });

it('parses npm 11 arrays and npm 12 package-keyed pack output', () => {
  const entry = { filename: 'fixture.tgz', files: [{ path: 'dist/index.js' }] };
  expect(packOutputFromJson(JSON.stringify([entry]))).toEqual(entry);
  expect(packOutputFromJson(JSON.stringify({ 'installer-fixture': entry }))).toEqual(entry);
});

it('selects the intended pack entry by package name when npm lists sibling workspace packages', () => {
  const runtime = { filename: 'agent-bundle-runtime-0.1.0.tgz', files: [{ path: 'dist/runtime.js' }], name: '@agent-bundle/runtime' };
  const bundle = { filename: 'agent-bundle-0.1.0.tgz', files: [{ path: 'dist/index.js' }], name: 'agent-bundle' };
  const scaffolder = { filename: 'create-agent-bundle-0.1.0.tgz', files: [{ path: 'dist/cli.js' }], name: 'create-agent-bundle' };
  const expected = { filename: bundle.filename, files: bundle.files };

  expect(packOutputFromJson(JSON.stringify([runtime, bundle, scaffolder]), 'agent-bundle')).toEqual(expected);
  expect(packOutputFromJson(JSON.stringify({
    '@agent-bundle/runtime': runtime,
    'agent-bundle': bundle,
    'create-agent-bundle': scaffolder,
  }), 'agent-bundle')).toEqual(expected);
  // npm 12 keys the object by name even when entries omit `name`.
  const { name: _name, ...unnamedBundle } = bundle;
  expect(packOutputFromJson(JSON.stringify({ 'agent-bundle': unnamedBundle }), 'agent-bundle')).toEqual(expected);

  expect(() => packOutputFromJson(JSON.stringify([runtime, bundle, scaffolder])))
    .toThrow(/returned 3 entries; expected exactly one/u);
  expect(() => packOutputFromJson(JSON.stringify([runtime, scaffolder]), 'agent-bundle'))
    .toThrow(/0 entries named "agent-bundle".*"@agent-bundle\/runtime", "create-agent-bundle"/u);
  expect(() => packOutputFromJson(JSON.stringify([bundle, bundle]), 'agent-bundle'))
    .toThrow(/2 entries named "agent-bundle"/u);
});

it('prepack validates the complete dry-run inventory', async () => {
  expect(await diagnostics()).toEqual([]);
  expect(result.pack.files.map((file) => file.path)).toContain('dist/bin/installer-fixture.js');
  expect(result.pack.files.map((file) => file.path)).toContain('host-packs/agent-bundle.manifest.json');
});

it('exposes --root, --output, and --json through the prepack command', async () => {
  const calls: unknown[] = [];
  const terminal = captureCliTerminal();
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const code = await runCli(
    ['prepack', '--root', projectRoot, '--output', 'host-packs', '--json'],
    terminal.output,
    {
      prepack: async (options) => {
        calls.push(options);
        return result;
      },
    },
  );
  expect(code).toBe(0);
  expect(calls).toEqual([expect.objectContaining({
    output: 'host-packs',
    packageOutputs: true,
    root: projectRoot,
  })]);
  expect(JSON.parse(terminal.stdout())).toMatchObject({
    build: { model: { metadata: { name: 'installer-fixture' } } },
    pack: { files: expect.any(Array) },
  });
});

it('reports missing allowlisted artifacts as AB7010', async () => {
  const pack = {
    ...result.pack,
    files: result.pack.files.filter((file) => file.path !== 'host-packs/cursor/INSTALL.md'),
  };
  expect(await diagnostics(pack)).toContainEqual(expect.objectContaining({ code: 'AB7010' }));
});

it('requires README.md even when the source file is absent', async () => {
  const readme = join(projectRoot, 'README.md');
  await rm(readme);
  try {
    const pack = {
      ...result.pack,
      files: result.pack.files.filter((file) => file.path !== 'README.md'),
    };
    expect(await diagnostics(pack)).toContainEqual(expect.objectContaining({
      code: 'AB7010',
      message: expect.stringContaining('"README.md"'),
    }));
  } finally {
    await writeFile(readme, '# Installer fixture\n');
  }
});

it('reports stale artifact hashes as AB7011', async () => {
  await writeFile(payloadPath, `${payloadBytes}stale\n`);
  try {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7011' }));
  } finally {
    await writeFile(payloadPath, payloadBytes);
  }
});

it('reports source-relative or unpacked package bins as AB7012', async () => {
  const packagePath = join(projectRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  document.bin = { 'installer-fixture': './src/cli.ts' };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7012' }));
  } finally {
    await writeFile(packagePath, original);
  }
});

it('reports package, model, host, and provenance version disagreement as AB7013', async () => {
  const packagePath = join(projectRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  document.version = '9.0.0';
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7013' }));
  } finally {
    await writeFile(packagePath, original);
  }
});

it('reports installed dependencies no packed JavaScript imports as AB7014, per field', async () => {
  const packagePath = join(projectRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  document.dependencies = { effect: '4.0.0', zod: '4.5.4' };
  document.peerDependencies = { react: '19.2.8' };
  document.devDependencies = { 'agent-bundle': 'workspace:*' };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    const reported = await diagnostics();
    expect(reported).toContainEqual(expect.objectContaining({
      code: 'AB7014',
      message: expect.stringContaining('dependencies names packages no packed JavaScript imports: "effect", "zod"'),
      recovery: expect.stringContaining('devDependencies'),
      severity: 'error',
    }));
    expect(reported).toContainEqual(expect.objectContaining({
      code: 'AB7014',
      message: expect.stringContaining('peerDependencies names packages no packed JavaScript imports: "react"'),
    }));
    // devDependencies never reach a consumer and are not inspected.
    expect(reported.filter((diagnostic) => diagnostic.code === 'AB7014')).toHaveLength(2);
    expect(reported.filter((diagnostic) => diagnostic.code === 'AB7015')).toHaveLength(0);
  } finally {
    await writeFile(packagePath, original);
  }
});

it('reports git, GitHub-shorthand, remote-tarball, and path dependency specifiers as AB7015', async () => {
  const packagePath = join(projectRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  document.dependencies = {
    '@agent-bundle/runtime': 'https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@42539ff',
    bashjsast: 'github:woolkingx/bashjsast#131f4b6',
    local: 'file:../local',
    shorthand: 'owner/repo',
    // Registry forms are not reported.
    alias: 'npm:effect@^4.0.0',
    tagged: 'latest',
    versioned: '^1.2.3',
    workspace: 'workspace:*',
  };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    const reported = await diagnostics();
    const nonRegistry = reported.filter((diagnostic) => diagnostic.code === 'AB7015');
    expect(nonRegistry).toEqual([expect.objectContaining({
      message: expect.stringContaining(
        '"@agent-bundle/runtime" -> "https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@42539ff", '
        + '"bashjsast" -> "github:woolkingx/bashjsast#131f4b6", "local" -> "file:../local", "shorthand" -> "owner/repo"',
      ),
      recovery: expect.stringContaining('registry'),
      severity: 'error',
    })]);
    expect(nonRegistry[0]?.message).not.toContain('"alias"');
    expect(nonRegistry[0]?.message).not.toContain('"workspace"');
  } finally {
    await writeFile(packagePath, original);
  }
});

it('accepts a dependency that packed JavaScript imports or requires', async () => {
  const packagePath = join(projectRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  document.dependencies = { 'left-pad': '^1.3.0', '@scope/required': '^2.0.0' };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  const consumer = join(projectRoot, 'dist', 'consumer.mjs');
  await writeFile(consumer, [
    'import leftPad from "left-pad/lib/index.js";',
    'const { createRequire } = await import("node:module");',
    'const require = createRequire(import.meta.url);',
    'const required = require("@scope/required/subpath");',
    '// import { Function } from "effect" -- a comment never counts.',
    'export { leftPad, required };',
    '',
  ].join('\n'));
  try {
    const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/consumer.mjs' }] };
    const reported = await diagnostics(pack);
    expect(reported.filter((diagnostic) => diagnostic.code === 'AB7014')).toHaveLength(0);
  } finally {
    await rm(consumer, { force: true });
    await writeFile(packagePath, original);
  }
});

it('installs a real packed tarball and runs its Cursor installer from node_modules', async () => {
  const tarballs = join(cleanupRoot, 'tarballs');
  const consumer = join(cleanupRoot, 'consumer');
  const home = join(cleanupRoot, 'home');
  await Promise.all([
    mkdir(tarballs),
    mkdir(consumer),
    mkdir(join(home, '.cursor'), { recursive: true }),
  ]);
  const { stdout } = await execFile('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], {
    cwd: projectRoot,
  });
  const packed = packOutputFromJson(stdout);
  await writeFile(join(consumer, 'package.json'), '{"private":true}\n');
  await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(tarballs, packed.filename)], {
    cwd: consumer,
  });
  const sourceCopy = join(cleanupRoot, 'source-copy');
  await cp(projectRoot, sourceCopy, { recursive: true, filter: (source) => source !== join(projectRoot, 'node_modules') });
  await rm(projectRoot, { force: true, recursive: true });

  const installedBin = join(consumer, 'node_modules', '.bin', 'installer-fixture');
  const installed = await execFile(installedBin, ['install', 'cursor', '--json'], {
    cwd: consumer,
    env: { ...process.env, HOME: home },
  });
  expect(JSON.parse(installed.stdout)).toMatchObject({ host: 'cursor', state: 'installed' });
  await expect(stat(join(home, '.cursor', 'plugins', 'local', 'installer-fixture'))).resolves.toBeDefined();
  expect(await readFile(join(sourceCopy, 'src', 'index.ts'), 'utf8')).toBe('export const value = 1;\n');
});
