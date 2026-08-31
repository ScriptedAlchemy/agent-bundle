import { expect, it } from '@rstest/core';

import type { buildPackageOutputs, PackageBuildResult } from '../src/build/package-build.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { DevPackageBuildService } from '../src/dev/package-build-service.ts';
import type { PreparedProject } from '../src/dev/project-service.ts';
import type { Invalidation } from '../src/dev/types.ts';

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
  readonly tools?: PreparedProject['tools'];
} = {}): PreparedProject => ({
  configPath: '/project/agent-bundle.config.ts',
  diagnostics: [],
  model: {
    ...(options.packageBuild === undefined ? {} : { packageBuild: options.packageBuild }),
  } as NormalizedPlugin,
  outputRoots: [],
  registry: undefined as never,
  root: '/project',
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
