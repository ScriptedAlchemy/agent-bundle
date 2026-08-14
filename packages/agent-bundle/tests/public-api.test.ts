import { execFile as executeFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { defineConfig, pathTokens } from '../src/index.ts';
import { runCli } from '../src/cli.ts';

interface PackageManifest {
  bin: {
    'agent-bundle': string;
  };
  engines?: {
    node?: string;
  };
  exports: Record<string, { import: string; types: string }>;
  version: string;
}

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages/agent-bundle');
let buildPromise: Promise<void> | undefined;

const buildPackage = async (): Promise<void> => {
  buildPromise ??= execFile('npm', ['run', 'build'], {
    cwd: workspaceRoot,
  }).then(() => undefined);
  await buildPromise;
};

const readPackageManifest = async (): Promise<PackageManifest> =>
  JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;

it('preserves a synchronous config and exposes opaque path tokens', () => {
  const config = { plugin: { name: 'demo', version: '1.0.0' } };
  expect(defineConfig(config)).toBe(config);
  expect(pathTokens).toEqual({
    pluginRoot: 'agent-bundle:path:plugin-root',
    pluginData: 'agent-bundle:path:plugin-data',
    workspaceRoot: 'agent-bundle:path:workspace-root',
  });
});

it('loads every public subpath and reports the package version', async () => {
  await expect(import('../src/api.ts')).resolves.toBeDefined();
  await expect(import('../src/config/index.ts')).resolves.toBeDefined();
  await expect(import('../src/eval/index.ts')).resolves.toBeDefined();
  await expect(runCli(['--version'])).resolves.toBe(0);
});

it('publishes directly executable built entrypoints with declarations', async () => {
  await buildPackage();

  const manifest = await readPackageManifest();
  expect(manifest.engines?.node).toBe('>=22.19.0');

  for (const entrypoint of Object.values(manifest.exports)) {
    await expect(access(join(packageRoot, entrypoint.import))).resolves.toBeUndefined();
    await expect(access(join(packageRoot, entrypoint.types))).resolves.toBeUndefined();
  }

  await expect(import('agent-bundle')).resolves.toBeDefined();
  await expect(import('agent-bundle/api')).resolves.toBeDefined();
  await expect(import('agent-bundle/config')).resolves.toBeDefined();
  await expect(import('agent-bundle/eval')).resolves.toBeDefined();

  const binPath = join(packageRoot, manifest.bin['agent-bundle']);
  const binSource = await readFile(binPath, 'utf8');
  expect(binSource.startsWith('#!/usr/bin/env node\n')).toBe(true);

  const { stdout } = await execFile(binPath, ['--version']);
  expect(stdout).toBe(`${manifest.version}\n`);
});

it('imports the externalized config entry from a packed npm consumer', async () => {
  await buildPackage();

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-consumer-'));
  try {
    const { stdout: packedOutput } = await execFile(
      'npm',
      ['pack', '--json', '--pack-destination', consumerRoot],
      { cwd: packageRoot },
    );
    const [packed] = JSON.parse(packedOutput) as Array<{ filename: string }>;
    const tarball = join(consumerRoot, packed.filename);

    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      { cwd: consumerRoot },
    );

    expect((await stat(join(packageRoot, 'dist/config.js'))).size).toBeLessThan(
      100_000,
    );
    await expect(
      execFile(process.execPath, [
        '--input-type=module',
        '--eval',
        "await import('agent-bundle/config');",
      ], { cwd: consumerRoot }),
    ).resolves.toMatchObject({ stderr: '', stdout: '' });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 15_000);
