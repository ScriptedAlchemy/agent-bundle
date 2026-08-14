import { createHash } from 'node:crypto';
import { execFile as executeFile } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const baselineCommit = '672f9f41c548487a468b9e7007d2f9de14da5a69';

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

it('copies an explicit recursive Inspector closure with byte-identical digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspector-sync-'));
  const source = join(root, 'source');
  const output = join(root, 'inspector');

  await mkdir(join(source, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(source, 'LICENSE'), 'MIT fixture license\n'),
    writeFile(join(source, 'src', 'entry.tsx'), [
      "import { createElement } from 'react';",
      "import { label } from './label.js';",
      'export const inspectorFixture = createElement(\'span\', null, label);',
      '',
    ].join('\n')),
    writeFile(join(source, 'src', 'label.ts'), "export const label = 'Inspector';\n"),
  ]);

  await expect(sync([
    '--source', source,
    '--out', output,
    '--commit', baselineCommit,
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
    commit: baselineCommit,
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
    writeFile(join(source, 'src', 'entry.ts'), "import 'react';\nexport const ready = true;\n"),
  ]);
  await sync([
    '--source', source,
    '--out', output,
    '--commit', baselineCommit,
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

it('retains the selected upstream tab contract as an executable Rstest fixture', async () => {
  const testPath = join(
    workspaceRoot,
    'packages',
    'workbench',
    'src',
    'inspector',
    'vendor',
    'clients',
    'web',
    'src',
    'utils',
    'inspectorTabs.test.ts',
  );
  await expect(readFile(testPath, 'utf8')).resolves.toContain('enumerates the liftable inspector tabs');

  const vendorTabs = '../src/inspector/vendor/clients/web/src/utils/inspectorTabs.ts';
  const tabs = await import(vendorTabs);
  expect(tabs.INSPECTOR_TAB_IDS).toEqual([
    'Apps', 'Tools', 'Prompts', 'Resources', 'Tasks', 'Logs', 'Protocol', 'Network',
  ]);
  expect(tabs.isInspectorTabId('Tools')).toBe(true);
  expect(tabs.isInspectorTabId('Servers')).toBe(false);
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
