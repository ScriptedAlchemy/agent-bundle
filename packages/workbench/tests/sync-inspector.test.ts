import { createHash } from 'node:crypto';
import { execFile as executeFile } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();

interface UpstreamManifest {
  readonly commit: string;
  readonly dependencies: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly upstreamSha256: string;
  }[];
  readonly repository: string;
  readonly schemaVersion: number;
}

const sync = async (args: readonly string[]): Promise<{ readonly stderr: string; readonly stdout: string }> =>
  execFile(process.execPath, ['scripts/sync-inspector.mjs', ...args], {
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH ?? '' },
  });

const sha256 = (contents: Uint8Array): string =>
  createHash('sha256').update(contents).digest('hex');

const commitFixtureSource = async (source: string): Promise<string> => {
  await execFile('git', ['init', '--quiet', source]);
  await execFile('git', ['-C', source, 'config', 'user.email', 'inspector-fixture@example.test']);
  await execFile('git', ['-C', source, 'config', 'user.name', 'Inspector fixture']);
  await execFile('git', ['-C', source, 'add', '.']);
  await execFile('git', ['-C', source, 'commit', '--quiet', '-m', 'fixture']);
  const { stdout } = await execFile('git', ['-C', source, 'rev-parse', 'HEAD']);
  return stdout.trim();
};

it('copies an explicit recursive Inspector closure with byte-identical digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspector-sync-'));
  const source = join(root, 'source');
  const output = join(root, 'inspector');

  await mkdir(join(source, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(source, 'LICENSE'), 'MIT fixture license\n'),
    writeFile(join(source, 'package.json'), JSON.stringify({
      dependencies: { '@modelcontextprotocol/client': '2.0.0' },
      name: 'inspector-fixture',
      version: '2.2.0',
    }, null, 2)),
    writeFile(join(source, 'src', 'entry.tsx'), [
      "import { createElement } from 'react';",
      "import { label } from './label.js';",
      'export const inspectorFixture = createElement(\'span\', null, label);',
      '',
    ].join('\n')),
    writeFile(join(source, 'src', 'label.ts'), "export const label = 'Inspector';\n"),
  ]);
  const commit = await commitFixtureSource(source);

  await expect(sync([
    '--source', source,
    '--out', output,
    '--commit', commit,
    '--repository', 'https://github.com/modelcontextprotocol/inspector.git',
    '--license', 'LICENSE',
    '--entry', 'src/entry.tsx',
    '--dependency', 'react',
    '--mcp-sdk-version', '2.0.0',
    '--version', '2.2.0',
  ])).resolves.toMatchObject({ stderr: '', stdout: expect.stringContaining('synced 2 files') });

  const [copiedEntry, sourceEntry, manifestText] = await Promise.all([
    readFile(join(output, 'vendor', 'src', 'entry.tsx')),
    readFile(join(source, 'src', 'entry.tsx')),
    readFile(join(output, 'UPSTREAM.json'), 'utf8'),
  ]);
  expect(copiedEntry).toEqual(sourceEntry);

  const manifest = JSON.parse(manifestText) as UpstreamManifest;
  expect(manifest).toMatchObject({
    commit,
    dependencies: ['react'],
    repository: 'https://github.com/modelcontextprotocol/inspector.git',
    schemaVersion: 1,
  });
  expect(manifest.files).toEqual([
    {
      path: 'src/entry.tsx',
      sha256: sha256(copiedEntry),
      upstreamSha256: sha256(sourceEntry),
    },
    {
      path: 'src/label.ts',
      sha256: sha256(await readFile(join(source, 'src', 'label.ts'))),
      upstreamSha256: sha256(await readFile(join(source, 'src', 'label.ts'))),
    },
  ]);
});

it('rejects a vendored import outside the declared dependency closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspector-verify-'));
  const source = join(root, 'source');
  const output = join(root, 'inspector');

  await mkdir(join(source, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(source, 'LICENSE'), 'MIT fixture license\n'),
    writeFile(join(source, 'package.json'), JSON.stringify({
      dependencies: { '@modelcontextprotocol/client': '2.0.0' },
      name: 'inspector-fixture',
      version: '2.2.0',
    }, null, 2)),
    writeFile(join(source, 'src', 'entry.ts'), "import 'react';\nexport const ready = true;\n"),
  ]);
  const commit = await commitFixtureSource(source);
  await sync([
    '--source', source,
    '--out', output,
    '--commit', commit,
    '--repository', 'https://github.com/modelcontextprotocol/inspector.git',
    '--license', 'LICENSE',
    '--entry', 'src/entry.ts',
    '--dependency', 'react',
    '--mcp-sdk-version', '2.0.0',
    '--version', '2.2.0',
  ]);
  await appendFile(join(output, 'vendor', 'src', 'entry.ts'), "import '@private/inspector-subpath';\n");

  await expect(sync(['--verify', '--out', output])).rejects.toMatchObject({
    stderr: expect.stringContaining('outside the declared dependency closure'),
  });
});

it('rejects unverified Inspector source bytes and metadata mismatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspector-provenance-'));
  const source = join(root, 'source');
  const unverifiedSource = join(root, 'unverified-source');
  const output = join(root, 'inspector');
  const writeFixture = async (directory: string): Promise<void> => {
    await mkdir(join(directory, 'src'), { recursive: true });
    await Promise.all([
      writeFile(join(directory, 'LICENSE'), 'MIT fixture license\n'),
      writeFile(join(directory, 'package.json'), JSON.stringify({
        dependencies: { '@modelcontextprotocol/client': '2.0.0' },
        name: 'inspector-fixture',
        version: '2.2.0',
      }, null, 2)),
      writeFile(join(directory, 'src', 'entry.ts'), "import 'react';\nexport const ready = true;\n"),
    ]);
  };
  await writeFixture(source);
  const commit = await commitFixtureSource(source);
  const commonArguments = [
    '--out', output,
    '--repository', 'https://github.com/modelcontextprotocol/inspector.git',
    '--license', 'LICENSE',
    '--entry', 'src/entry.ts',
    '--dependency', 'react',
  ];

  await expect(sync([
    '--source', source,
    '--commit', '0000000000000000000000000000000000000000',
    '--version', '2.2.0',
    '--mcp-sdk-version', '2.0.0',
    ...commonArguments,
  ])).rejects.toMatchObject({
    stderr: expect.stringContaining(`--source is at ${commit}`),
  });
  await expect(sync([
    '--source', source,
    '--commit', commit,
    '--version', '9.9.9',
    '--mcp-sdk-version', '2.0.0',
    ...commonArguments,
  ])).rejects.toMatchObject({
    stderr: expect.stringContaining('upstream package version 2.2.0 does not match --version 9.9.9'),
  });
  await expect(sync([
    '--source', source,
    '--commit', commit,
    '--version', '2.2.0',
    '--mcp-sdk-version', '9.9.9',
    ...commonArguments,
  ])).rejects.toMatchObject({
    stderr: expect.stringContaining('upstream @modelcontextprotocol/client version 2.0.0 does not match --mcp-sdk-version 9.9.9'),
  });

  await writeFixture(unverifiedSource);
  await expect(sync([
    '--source', unverifiedSource,
    '--commit', commit,
    '--version', '2.2.0',
    '--mcp-sdk-version', '2.0.0',
    ...commonArguments,
  ])).rejects.toMatchObject({
    stderr: expect.stringContaining('--source must be a Git checkout'),
  });
});

it('runs the retained upstream inspectorTabs test directly under Rstest', async () => {
  const testPath = 'packages/workbench/src/inspector/vendor/clients/web/src/utils/inspectorTabs.test.ts';
  const { stdout } = await execFile('npx', ['--no-install', 'rstest', '--config', 'rstest.config.ts', testPath], {
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH ?? '' },
  });

  expect(stdout).toContain('inspectorTabs.test.ts');
});

it('keeps Inspector network sync behind an explicit maintainer command', async () => {
  const packageJson = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')) as {
    readonly scripts: Readonly<Record<string, string>>;
  };

  expect(packageJson.scripts['sync:inspector']).toContain('scripts/sync-inspector.mjs');
  expect(packageJson.scripts['sync:inspector']).toContain('--commit 672f9f41c548487a468b9e7007d2f9de14da5a69');
  for (const name of ['build', 'test', 'lint', 'typecheck', 'check']) {
    expect(packageJson.scripts[name]).not.toContain('sync-inspector');
  }
});
