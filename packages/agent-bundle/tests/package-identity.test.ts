import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { normalizeProject, validateSource, type NormalizationTargetRegistry } from '../src/config/index.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import {
  createProjectContext,
  isValidPackageName,
  isValidPackageVersion,
  projectVersionLabel,
  snapshotPackageIdentity,
} from '../src/core/project-context.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import { ProjectService } from '../src/dev/project-service.ts';

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => name === 'portable',
  supports: () => false,
};

const config = (version = '1.0.0'): AgentBundleConfig => ({
  plugin: { name: 'identity-fixture', version },
});

const loadedProject = (root: string, pluginVersion = '1.0.0'): LoadedConfig => ({
  config: config(pluginVersion),
  configPath: join(root, 'agent-bundle.config.ts'),
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

const withProject = async (
  packageJson: string | undefined,
  run: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-package-identity-'));
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    if (packageJson !== undefined) await writeFile(join(root, 'package.json'), packageJson);
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

it('accepts npm package names and strict semver versions only', () => {
  expect(isValidPackageName('@agent-bundle-example/audiobook-curator')).toBe(true);
  expect(isValidPackageName('audiobook-curator')).toBe(true);
  expect(isValidPackageName('UpperCase')).toBe(false);
  expect(isValidPackageName('.hidden')).toBe(false);
  expect(isValidPackageName('a'.repeat(215))).toBe(false);
  expect(isValidPackageName('')).toBe(false);
  // npm-reserved names fail even though the grammar matches.
  expect(isValidPackageName('node_modules')).toBe(false);
  expect(isValidPackageName('favicon.ico')).toBe(false);

  expect(isValidPackageVersion('1.0.0')).toBe(true);
  expect(isValidPackageVersion('0.0.0-dev')).toBe(true);
  expect(isValidPackageVersion('1.2.3-rc.1+build.5')).toBe(true);
  expect(isValidPackageVersion('v1.0.0')).toBe(false);
  expect(isValidPackageVersion('1.0')).toBe(false);
  expect(isValidPackageVersion('01.0.0')).toBe(false);
  // Invalid prerelease identifiers: leading-zero numerics and empty parts.
  expect(isValidPackageVersion('1.0.0-01')).toBe(false);
  expect(isValidPackageVersion('1.0.0-alpha..1')).toBe(false);
  expect(isValidPackageVersion('1.0.0-.')).toBe(false);
});

it('derives both package identity axes from a packaged project', async () => {
  await withProject(JSON.stringify({ name: '@scope/pkg', version: '2.3.4' }), async (root) => {
    expect(snapshotPackageIdentity(root)).toEqual({
      issues: [],
      packageName: '@scope/pkg',
      packageVersion: '2.3.4',
    });
  });
});

it('treats a missing package.json as a normal development state', async () => {
  await withProject(undefined, async (root) => {
    expect(snapshotPackageIdentity(root)).toEqual({ issues: [] });
  });
});

it('withholds invalid identity values as issues instead of crashing', async () => {
  await withProject(JSON.stringify({ name: 'Not Valid!', version: 'one.two' }), async (root) => {
    const identity = snapshotPackageIdentity(root);
    expect(identity.packageName).toBeUndefined();
    expect(identity.packageVersion).toBeUndefined();
    expect(identity.issues).toMatchObject([
      { kind: 'invalid-name' },
      { kind: 'invalid-version' },
    ]);
  });
  await withProject('not json', async (root) => {
    expect(snapshotPackageIdentity(root).issues).toMatchObject([{ kind: 'unparsable' }]);
  });
});

it('labels the development fallback distinctly from a release version', () => {
  expect(projectVersionLabel({ packageVersion: '1.0.0', revision: 'a'.repeat(64) })).toBe('1.0.0');
  const fallback = projectVersionLabel({ revision: 'abc123def4567890'.padEnd(64, '0') });
  expect(fallback).toBe('0.0.0-dev.abc123def456 (development fallback — no package.json version)');
});

it('carries the derived axes through the normalized model into the project context', async () => {
  await withProject(JSON.stringify({ name: '@scope/pkg', version: '2.3.4' }), async (root) => {
    const loaded = loadedProject(root, '2.3.4');
    const model = await normalizeProject(loaded, { skills: [] }, registry);
    expect(model.metadata).toMatchObject({ packageName: '@scope/pkg', packageVersion: '2.3.4', version: '2.3.4' });

    const configSha = createHash('sha256').update('export default {};\n').digest('hex');
    const context = createProjectContext({
      configPath: loaded.configPath,
      model,
      root,
      sourceInputs: [{ path: 'agent-bundle.config.ts', sha256: configSha }],
    });
    expect(context.packageName).toBe('@scope/pkg');
    expect(context.packageVersion).toBe('2.3.4');
    expect(projectVersionLabel(context)).toBe('2.3.4');
  });
});

it('omits both axes from the model and context for unpackaged projects', async () => {
  await withProject(undefined, async (root) => {
    const loaded = loadedProject(root);
    const model = await normalizeProject(loaded, { skills: [] }, registry);
    expect(model.metadata.packageName).toBeUndefined();
    expect(model.metadata.packageVersion).toBeUndefined();

    const configSha = createHash('sha256').update('export default {};\n').digest('hex');
    const context = createProjectContext({
      configPath: loaded.configPath,
      model,
      root,
      sourceInputs: [{ path: 'agent-bundle.config.ts', sha256: configSha }],
    });
    expect(context.packageName).toBeUndefined();
    expect(context.packageVersion).toBeUndefined();
    expect(projectVersionLabel(context)).toContain('development fallback');
  });
});

it('warns with AB4008 when plugin.version differs from the package version', async () => {
  await withProject(JSON.stringify({ name: '@scope/pkg', version: '2.0.0' }), async (root) => {
    const diagnostics = validateSource(loadedProject(root, '1.0.0'), { skills: [] }, registry);
    expect(diagnostics).toMatchObject([{
      code: 'AB4008',
      severity: 'warning',
      sourcePath: join(root, 'agent-bundle.config.ts'),
    }]);
    expect(diagnostics[0]!.message).toContain('"1.0.0"');
    expect(diagnostics[0]!.message).toContain('"2.0.0"');
  });
});

it('stays silent when plugin.version matches the package version or no package version exists', async () => {
  await withProject(JSON.stringify({ name: '@scope/pkg', version: '1.0.0' }), async (root) => {
    expect(validateSource(loadedProject(root, '1.0.0'), { skills: [] }, registry)).toEqual([]);
  });
  await withProject(JSON.stringify({ name: '@scope/pkg' }), async (root) => {
    expect(validateSource(loadedProject(root, '1.0.0'), { skills: [] }, registry)).toEqual([]);
  });
  await withProject(undefined, async (root) => {
    expect(validateSource(loadedProject(root, '1.0.0'), { skills: [] }, registry)).toEqual([]);
  });
});

it('warns with AB4009/AB4010/AB4011 for invalid package identity values', async () => {
  await withProject(JSON.stringify({ name: 'Not Valid!', version: 'one.two' }), async (root) => {
    expect(validateSource(loadedProject(root), { skills: [] }, registry)).toMatchObject([
      { code: 'AB4009', severity: 'warning', sourcePath: join(root, 'package.json') },
      { code: 'AB4010', severity: 'warning', sourcePath: join(root, 'package.json') },
    ]);
  });
  await withProject('not json', async (root) => {
    expect(validateSource(loadedProject(root), { skills: [] }, registry)).toMatchObject([
      { code: 'AB4011', severity: 'warning', sourcePath: join(root, 'package.json') },
    ]);
  });
});

it('ignores a package.json symlinked outside the project root', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'agent-bundle-outside-identity-'));
  await writeFile(join(outside, 'package.json'), JSON.stringify({ name: '@scope/outside', version: '9.9.9' }));
  await withProject(undefined, async (root) => {
    await symlink(join(outside, 'package.json'), join(root, 'package.json'));
    const identity = snapshotPackageIdentity(root);
    expect(identity.packageName).toBeUndefined();
    expect(identity.packageVersion).toBeUndefined();
    expect(identity.issues).toMatchObject([{ kind: 'outside-root' }]);
    expect(validateSource(loadedProject(root), { skills: [] }, registry)).toMatchObject([
      { code: 'AB4011', severity: 'warning' },
    ]);
  });
  await rm(outside, { force: true, recursive: true });
});

it('exposes the derived axes on the development source status', async () => {
  await withProject(JSON.stringify({ name: '@scope/pkg', version: '2.3.4' }), async (root) => {
    await writeFile(
      join(root, 'agent-bundle.config.ts'),
      "export default { plugin: { name: 'identity-fixture', version: '2.3.4' }, targets: ['portable'] };\n",
    );
    const prepared = await new ProjectService({ root, targets: ['portable'] }).prepare('inspect');
    expect(prepared.source).toMatchObject({
      packageName: '@scope/pkg',
      packageVersion: '2.3.4',
      state: 'ready',
    });
    expect(prepared.projectContext).toMatchObject({ packageName: '@scope/pkg', packageVersion: '2.3.4' });
  });
  await withProject(JSON.stringify({ name: '@scope/pkg' }), async (root) => {
    await writeFile(
      join(root, 'agent-bundle.config.ts'),
      "export default { plugin: { name: 'identity-fixture', version: '1.0.0' }, targets: ['portable'] };\n",
    );
    const prepared = await new ProjectService({ root, targets: ['portable'] }).prepare('inspect');
    expect(prepared.source.packageName).toBe('@scope/pkg');
    expect(prepared.source.packageVersion).toBeUndefined();
    expect(prepared.source.state).toBe('ready');
  });
});
