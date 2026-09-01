import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  derivePackageIdentity,
  fallbackDevPackageName,
  fallbackDevPackageVersion,
  isPackageName,
  isSemanticPackageVersion,
  packageVersionMismatchDiagnostic,
  readProjectPackageJson,
} from '../src/core/project-context.ts';
import { ProjectService } from '../src/dev/project-service.ts';

const skillMarkdown = [
  '---',
  'name: review',
  'description: Reviews changes',
  '---',
  'Review the changed files.',
  '',
].join('\n');

const writeProject = async (options: {
  readonly packageJson?: string;
  readonly pluginVersion?: string;
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-project-identity-'));
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        `  plugin: { name: 'identity-fixture', version: '${options.pluginVersion ?? '1.0.0'}' },`,
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'skills', 'review', 'SKILL.md'), skillMarkdown),
    ...(options.packageJson === undefined
      ? []
      : [writeFile(join(root, 'package.json'), options.packageJson)]),
  ]);
  return root;
};

it('accepts scoped package names and semantic versions', () => {
  expect(isPackageName('@agent-bundle-example/audiobook-curator')).toBe(true);
  expect(isPackageName('dev-project')).toBe(true);
  expect(isPackageName('')).toBe(false);
  expect(isPackageName(' padded ')).toBe(false);
  expect(isSemanticPackageVersion('1.0.0')).toBe(true);
  expect(isSemanticPackageVersion('0.0.0-dev')).toBe(true);
  expect(isSemanticPackageVersion('1.2.3-beta.1+build.5')).toBe(true);
  expect(isSemanticPackageVersion('01.0.0')).toBe(false);
  expect(isSemanticPackageVersion('1.0')).toBe(false);
});

it('derives package identity from package.json and falls back when version is absent', async () => {
  const packaged = await writeProject({
    packageJson: JSON.stringify({ name: '@scope/packaged', version: '2.4.0', type: 'module' }),
  });
  const unpackaged = await writeProject({
    packageJson: JSON.stringify({ name: '@scope/unpackaged', type: 'module' }),
  });
  const missing = await writeProject({});
  try {
    expect(derivePackageIdentity(packaged)).toEqual({
      packageName: '@scope/packaged',
      packageVersion: '2.4.0',
      source: 'package.json',
    });
    expect(readProjectPackageJson(packaged)).toMatchObject({
      identity: { packageName: '@scope/packaged', packageVersion: '2.4.0' },
      packageName: '@scope/packaged',
    });
    expect(derivePackageIdentity(unpackaged)).toEqual({
      packageName: '@scope/unpackaged',
      packageVersion: fallbackDevPackageVersion,
      source: 'dev-fallback',
    });
    expect(derivePackageIdentity(missing)).toEqual({
      packageName: fallbackDevPackageName,
      packageVersion: fallbackDevPackageVersion,
      source: 'dev-fallback',
    });
  } finally {
    await Promise.all([
      rm(packaged, { force: true, recursive: true }),
      rm(unpackaged, { force: true, recursive: true }),
      rm(missing, { force: true, recursive: true }),
    ]);
  }
});

it('warns only when plugin.version differs from a real package.json version', () => {
  expect(packageVersionMismatchDiagnostic('1.0.0', '1.0.0', 'agent-bundle.config.ts')).toBeUndefined();
  expect(packageVersionMismatchDiagnostic('1.0.0', '2.4.0', 'agent-bundle.config.ts')).toMatchObject({
    code: 'AB4008',
    severity: 'warning',
    sourcePath: 'agent-bundle.config.ts',
  });
});

it('exposes package identity on inspect, source status, and keeps plugin.name untouched', async () => {
  const packaged = await writeProject({
    packageJson: JSON.stringify({ name: '@scope/packaged', version: '2.4.0', type: 'module' }),
    pluginVersion: '2.4.0',
  });
  const mismatched = await writeProject({
    packageJson: JSON.stringify({ name: '@scope/mismatched', version: '9.9.9', type: 'module' }),
    pluginVersion: '1.0.0',
  });
  try {
    const ready = await new ProjectService({ root: packaged }).prepare('inspect');
    expect(ready.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4008')).toEqual([]);
    expect(ready.model?.metadata.name).toBe('identity-fixture');
    expect(ready.model?.metadata.version).toBe('2.4.0');
    expect(ready.model?.packageName).toBe('@scope/packaged');
    expect(ready.model?.packageVersion).toBe('2.4.0');
    expect(ready.projectContext).toMatchObject({
      packageName: '@scope/packaged',
      packageVersion: '2.4.0',
    });
    expect(ready.source).toMatchObject({
      packageName: '@scope/packaged',
      packageVersion: '2.4.0',
      state: 'ready',
    });
    expect(ready.projectContext?.sourceInputs.map((input) => input.path)).toEqual(
      expect.arrayContaining(['package.json']),
    );

    const conflict = await new ProjectService({ root: mismatched }).prepare('inspect');
    expect(conflict.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB4008', severity: 'warning' }),
    ]));
    expect(conflict.model?.metadata.name).toBe('identity-fixture');
    expect(conflict.model?.packageVersion).toBe('9.9.9');
    expect(conflict.projectContext?.packageVersion).toBe('9.9.9');
  } finally {
    await Promise.all([
      rm(packaged, { force: true, recursive: true }),
      rm(mismatched, { force: true, recursive: true }),
    ]);
  }
});

it('uses package.json as the only version source for audiobook-curator and labels other examples', async () => {
  const examplesRoot = join(process.cwd(), 'examples');
  const audiobook = await new ProjectService({ root: join(examplesRoot, 'audiobook-curator') }).prepare('inspect');
  expect(audiobook.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4008')).toEqual([]);
  expect(audiobook.model?.metadata.name).toBe('audiobook-curator');
  expect(audiobook.model?.packageName).toBe('@agent-bundle-example/audiobook-curator');
  expect(audiobook.model?.packageVersion).toBe('1.0.0');
  expect(audiobook.projectContext?.packageName).toBe('@agent-bundle-example/audiobook-curator');
  expect(audiobook.projectContext?.packageVersion).toBe('1.0.0');
  expect(audiobook.source.packageVersion).toBe('1.0.0');

  for (const example of [
    ['skills-starter', '@agent-bundle-example/skills-starter'],
    ['hooks-and-scripts', '@agent-bundle-example/hooks-and-scripts'],
    ['mcp-app', '@agent-bundle-example/mcp-app'],
    ['rsc-agent-runtime', '@agent-bundle/rsc-agent-runtime-demo'],
  ] as const) {
    const prepared = await new ProjectService({ root: join(examplesRoot, example[0]) }).prepare('inspect');
    expect(prepared.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4008')).toEqual([]);
    expect(prepared.model?.metadata.name).not.toBe(example[1]);
    expect(prepared.model?.packageName).toBe(example[1]);
    expect(prepared.model?.packageVersion).toBe(fallbackDevPackageVersion);
    expect(prepared.projectContext?.packageVersion).toBe(fallbackDevPackageVersion);
    expect(prepared.source.packageVersion).toBe(fallbackDevPackageVersion);
  }
});
