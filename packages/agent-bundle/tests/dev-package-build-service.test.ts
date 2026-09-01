import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import type { buildPackageOutputs, PackageBuildResult } from '../src/build/package-build.ts';
import type { AgentBundleToolsConfig, NormalizedPlugin } from '../src/core/types.ts';
import { DevPackageBuildService } from '../src/dev/package-build-service.ts';
import type { PreparedProject } from '../src/dev/project-service.ts';
import type { Invalidation } from '../src/dev/types.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type BuildOutputs = typeof buildPackageOutputs;

const packageBuild = (binName: string): NormalizedPlugin['packageBuild'] => ({
  bins: [{
    id: `bin:${binName}`,
    name: binName,
    provenance: { kind: 'conventional', sourcePath: `/project/src/cli.ts` },
    source: '/project/src/cli.ts',
  }],
  outputDir: 'dist',
});

const prepared = (options: {
  readonly packageBuild?: NormalizedPlugin['packageBuild'];
  readonly root?: string;
  readonly tools?: PreparedProject['tools'];
} = {}): PreparedProject => ({
  configPath: `${options.root ?? '/project'}/agent-bundle.config.ts`,
  diagnostics: [],
  model: {
    ...(options.packageBuild === undefined ? {} : { packageBuild: options.packageBuild }),
  } as NormalizedPlugin,
  outputRoots: [],
  registry: undefined as never,
  root: options.root ?? '/project',
  snapshotSource: async () => ({ inputs: [], revision: 'test-revision' }),
  source: { diagnostics: [], state: 'ready' },
  ...(options.tools === undefined ? {} : { tools: options.tools }),
});

const invalidation = (
  reason: Invalidation['reason'],
  paths: readonly string[] = [],
): Invalidation => ({
  occurredAt: '2026-08-30T12:00:00.000Z',
  paths,
  reason,
});

const buildResult = (sourceInputs: readonly string[]): PackageBuildResult => ({
  files: [{
    bytes: 1,
    kind: 'bundle',
    path: 'bin/tool.js',
    sha256: '0'.repeat(64),
    sourceInputs,
  }],
  outputRoot: '/project/dist',
});

it('reports absent projects without invoking the package build', async () => {
  const calls: unknown[] = [];
  const service = new DevPackageBuildService({
    buildOutputs: (async (options) => {
      calls.push(options);
      return buildResult([]);
    }) as BuildOutputs,
  });

  await expect(service.build(prepared(), invalidation('initial'))).resolves.toEqual({
    diagnostics: [],
    state: 'absent',
  });
  expect(calls).toHaveLength(0);
});

it('builds initially, skips untracked changes, and rebuilds tracked inputs', async () => {
  let builds = 0;
  const service = new DevPackageBuildService({
    buildOutputs: (async () => {
      builds += 1;
      return buildResult(['agent-bundle.config.ts', 'src/cli.ts', 'src/util.ts']);
    }) as BuildOutputs,
  });
  const project = prepared({ packageBuild: packageBuild('tool') });

  await expect(service.build(project, invalidation('initial'))).resolves.toEqual({
    diagnostics: [],
    state: 'built',
  });
  expect(builds).toBe(1);

  await expect(service.build(project, invalidation('source-change', ['skills/review/SKILL.md'])))
    .resolves.toEqual({ diagnostics: [], state: 'skipped' });
  expect(builds).toBe(1);

  await expect(service.build(project, invalidation('source-change', ['src/util.ts'])))
    .resolves.toEqual({ diagnostics: [], state: 'built' });
  expect(builds).toBe(2);
});

it.each([
  { label: 'package.json', paths: ['package.json'] },
  { label: 'tsconfig.json', paths: ['tsconfig.json'] },
])('always rebuilds when $label changes', async ({ paths }) => {
  let builds = 0;
  const service = new DevPackageBuildService({
    buildOutputs: (async () => {
      builds += 1;
      return buildResult(['src/cli.ts']);
    }) as BuildOutputs,
  });
  const project = prepared({ packageBuild: packageBuild('tool') });

  await service.build(project, invalidation('initial'));
  await expect(service.build(project, invalidation('source-change', paths)))
    .resolves.toMatchObject({ state: 'built' });
  expect(builds).toBe(2);
});

it('rebuilds on manual invalidations and on package build identity changes', async () => {
  let builds = 0;
  const service = new DevPackageBuildService({
    buildOutputs: (async () => {
      builds += 1;
      return buildResult(['src/cli.ts']);
    }) as BuildOutputs,
  });

  await service.build(prepared({ packageBuild: packageBuild('tool') }), invalidation('initial'));
  await expect(service.build(
    prepared({ packageBuild: packageBuild('tool') }),
    invalidation('manual', []),
  )).resolves.toMatchObject({ state: 'built' });
  await expect(service.build(
    prepared({ packageBuild: packageBuild('renamed') }),
    invalidation('source-change', ['skills/review/SKILL.md']),
  )).resolves.toMatchObject({ state: 'built' });
  expect(builds).toBe(3);
});

it('surfaces failures as one AB7103 warning and retries on the next change', async () => {
  let attempts = 0;
  const service = new DevPackageBuildService({
    buildOutputs: (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('declaration generation failed');
      return buildResult(['src/cli.ts']);
    }) as BuildOutputs,
  });
  const project = prepared({ packageBuild: packageBuild('tool') });

  await expect(service.build(project, invalidation('initial'))).resolves.toEqual({
    diagnostics: [{
      code: 'AB7103',
      message: 'Package build (bin/lib) failed during development rebuild: declaration generation failed',
      severity: 'warning',
      sourcePath: '/project/agent-bundle.config.ts',
    }],
    state: 'failed',
  });

  // A failed build never records inputs, so even an untracked change retries.
  await expect(service.build(project, invalidation('source-change', ['skills/review/SKILL.md'])))
    .resolves.toMatchObject({ state: 'built' });
  expect(attempts).toBe(2);
});

it('always rebuilds when the configuration file itself changes', async () => {
  let builds = 0;
  const service = new DevPackageBuildService({
    buildOutputs: (async () => {
      builds += 1;
      return buildResult(['src/cli.ts']);
    }) as BuildOutputs,
  });
  const project = prepared({ packageBuild: packageBuild('tool') });

  await service.build(project, invalidation('initial'));
  await expect(service.build(project, invalidation('source-change', ['agent-bundle.config.ts'])))
    .resolves.toMatchObject({ state: 'built' });
  expect(builds).toBe(2);
});

it('includes the tools hatch in the rebuild identity, comparing functions by source', async () => {
  let builds = 0;
  const service = new DevPackageBuildService({
    buildOutputs: (async () => {
      builds += 1;
      return buildResult(['src/cli.ts']);
    }) as BuildOutputs,
  });
  const build = packageBuild('tool');
  // Fresh function instances with identical source text, as a re-evaluated
  // but unchanged configuration produces.
  const unchangedHatch = (): AgentBundleToolsConfig =>
    ({ rspack: (config: { name?: string }) => { config.name = 'unchanged'; } }) as AgentBundleToolsConfig;
  const editedHatch: AgentBundleToolsConfig =
    ({ rspack: (config: { name?: string }) => { config.name = 'edited'; } }) as AgentBundleToolsConfig;

  await service.build(prepared({ packageBuild: build, tools: unchangedHatch() }), invalidation('initial'));
  expect(builds).toBe(1);

  // An identical hatch source with an untracked change skips.
  await expect(service.build(
    prepared({ packageBuild: build, tools: unchangedHatch() }),
    invalidation('source-change', ['skills/review/SKILL.md']),
  )).resolves.toMatchObject({ state: 'skipped' });
  expect(builds).toBe(1);

  // A changed hatch rebuilds even when no tracked source input changed.
  await expect(service.build(
    prepared({ packageBuild: build, tools: editedHatch }),
    invalidation('source-change', ['skills/review/SKILL.md']),
  )).resolves.toMatchObject({ state: 'built' });
  expect(builds).toBe(2);

  // An rsbuild-fragment change rebuilds too.
  await expect(service.build(
    prepared({ packageBuild: build, tools: { rsbuild: { output: { legalComments: 'linked' } } } }),
    invalidation('source-change', ['skills/review/SKILL.md']),
  )).resolves.toMatchObject({ state: 'built' });
  expect(builds).toBe(3);
});

it('removes the outputs it published when the package build disappears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-package-remove-'));
  roots.push(root);
  const outputRoot = join(root, 'dist');
  await mkdir(join(outputRoot, 'bin'), { recursive: true });
  await writeFile(join(outputRoot, 'bin', 'tool.js'), '#!/usr/bin/env node\n');
  await writeFile(join(outputRoot, 'index.js'), 'export {};\n');
  await writeFile(join(outputRoot, 'index.d.ts'), 'export {};\n');
  // A file this session never published must survive the cleanup.
  await writeFile(join(outputRoot, 'foreign.txt'), 'not ours\n');

  const service = new DevPackageBuildService({
    buildOutputs: (async () => ({
      files: [
        { bytes: 1, kind: 'bundle' as const, path: 'bin/tool.js', sha256: '0'.repeat(64), sourceInputs: ['src/cli.ts'] },
        { bytes: 1, kind: 'bundle' as const, path: 'index.js', sha256: '0'.repeat(64), sourceInputs: ['src/index.ts'] },
        { bytes: 1, kind: 'generated' as const, path: 'index.d.ts', sha256: '0'.repeat(64), sourceInputs: ['src/index.ts'] },
      ],
      outputRoot,
    })) as BuildOutputs,
  });

  await expect(service.build(
    prepared({ packageBuild: packageBuild('tool'), root }),
    invalidation('initial'),
  )).resolves.toMatchObject({ state: 'built' });

  await expect(service.build(prepared({ root }), invalidation('source-change', ['agent-bundle.config.ts'])))
    .resolves.toEqual({ diagnostics: [], state: 'removed' });
  expect((await readdir(outputRoot)).sort()).toEqual(['foreign.txt']);

  // With nothing published, a package-less project is simply absent.
  await expect(service.build(prepared({ root }), invalidation('source-change', [])))
    .resolves.toEqual({ diagnostics: [], state: 'absent' });
});

it('prunes the output root entirely when it only held published outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-package-prune-'));
  roots.push(root);
  const outputRoot = join(root, 'dist');
  await mkdir(join(outputRoot, 'bin'), { recursive: true });
  await writeFile(join(outputRoot, 'bin', 'tool.js'), '#!/usr/bin/env node\n');

  const service = new DevPackageBuildService({
    buildOutputs: (async () => ({
      files: [
        { bytes: 1, kind: 'bundle' as const, path: 'bin/tool.js', sha256: '0'.repeat(64), sourceInputs: ['src/cli.ts'] },
      ],
      outputRoot,
    })) as BuildOutputs,
  });

  await service.build(prepared({ packageBuild: packageBuild('tool'), root }), invalidation('initial'));
  await expect(service.build(prepared({ root }), invalidation('manual', [])))
    .resolves.toEqual({ diagnostics: [], state: 'removed' });
  expect((await readdir(root)).includes('dist')).toBe(false);
});

it('passes the prepared tools escape hatch through to the package build', async () => {
  const received: unknown[] = [];
  const tools = { rsbuild: { output: { legalComments: 'linked' as const } } };
  const service = new DevPackageBuildService({
    buildOutputs: (async (options) => {
      received.push(options.tools);
      return buildResult(['src/cli.ts']);
    }) as BuildOutputs,
  });

  await service.build(
    prepared({ packageBuild: packageBuild('tool'), tools }),
    invalidation('initial'),
  );
  expect(received).toEqual([tools]);
});
