import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { EpochStore } from '../src/dev/epoch-store.ts';
import { build } from '../src/build/build.ts';
import { writeManifest } from '../src/build/emit.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { ArtifactService } from '../src/dev/index.ts';
import { ProjectService } from '../src/dev/project-service.ts';

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-service-'));
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'artifact-service-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'skills', 'review', 'SKILL.md'),
      [
        '---',
        'name: review',
        'description: Reviews changes',
        '---',
        'Review the changed files.',
        '',
      ].join('\n'),
    ),
  ]);
  return root;
};

it('publishes one validated prepared project as an immutable epoch and removes its build attempt', async () => {
  const root = await createProject();
  const attemptRoot = join(root, '.agent-bundle', 'test-attempt');
  const store = new EpochStore({ projectRoot: root });
  const removedAttempts: string[] = [];

  try {
    const prepared = await new ProjectService({ root }).prepare('build');
    const service = new ArtifactService({
      createAttempt: async () => {
        await mkdir(attemptRoot, { recursive: true });
        return attemptRoot;
      },
      createEpochId: () => 'epoch-one',
      epochStore: store,
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      removeAttempt: async (path) => {
        removedAttempts.push(path);
        await rm(path, { force: true, recursive: true });
      },
    });

    const result = await service.build(prepared);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    }

    expect(result).toMatchObject({
      epoch: {
        configDigest: sha256(await readFile(join(root, 'agent-bundle.config.ts'))),
        createdAt: '2026-08-14T12:00:00.000Z',
        id: 'epoch-one',
        projectRevision: prepared.source.revision,
      },
      outcome: 'succeeded',
    });
    expect(result.epoch.modelDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.epoch.targetDigests.portable).toMatch(/^[a-f0-9]{64}$/);
    expect(result.epoch.manifestPath).toBe(
      join(root, '.agent-bundle', 'epochs', 'epoch-one', 'agent-bundle.manifest.json'),
    );
    expect(await store.readActiveEpoch()).toEqual(result.epoch);
    await expect(readFile(join(root, '.agent-bundle', 'epochs', 'epoch-one', 'portable', 'plugin.json'), 'utf8'))
      .resolves.toContain('artifact-service-fixture');
    expect(removedAttempts).toEqual([attemptRoot]);
    await expect(readFile(attemptRoot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('allows only an exact epoch store marker as an extra staged artifact file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-staged-artifact-validation-'));
  const marker = '.agent-bundle-epoch-stage.json';
  try {
    await writeFile(join(root, 'plugin.json'), '{"name":"valid"}\n');
    await writeManifest({ artifactRoot: root, targets: ['portable'] });
    await writeFile(join(root, marker), '{"token":"8f2aa8b7-bdd2-4065-8cd3-5184c6bd9f74","version":1}\n');

    const allowedContext: Readonly<{ readonly allowEpochStagingMarker: true; readonly artifactRoot: string }> = {
      allowEpochStagingMarker: true,
      artifactRoot: root,
    };
    expect(await validateArtifact(allowedContext)).toEqual([]);

    await writeFile(join(root, 'unexpected.txt'), 'tampered\n');
    expect(await validateArtifact(allowedContext)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
    await rm(join(root, 'unexpected.txt'));
    await writeFile(join(root, marker), '{"token":"not-a-uuid","version":1}\n');
    expect(await validateArtifact(allowedContext)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each(['added', 'changed', 'removed'] as const)(
  'rejects publication when an authored source is $0 after compiling',
  async (mutation) => {
    const root = await createProject();
    const store = new EpochStore({ projectRoot: root });
    const deletedSource = join(root, 'skills', 'review', 'guide.txt');
    const attempts: string[] = [];
    try {
      if (mutation === 'removed') await writeFile(deletedSource, 'Guide before removal.\n');
      const prepared = await new ProjectService({ root }).prepare('build');
      await mkdir(join(root, '.agent-bundle'), { recursive: true });
      const service = new ArtifactService({
        compile: async (options) => {
          const result = await build(options);
          if (mutation === 'added') {
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src', 'added.ts'), 'export const added = true;\n');
          } else if (mutation === 'changed') {
            await writeFile(join(root, 'skills', 'review', 'SKILL.md'), [
              '---',
              'name: review',
              'description: Reviews changed source',
              '---',
              'Review the changed files.',
              '',
            ].join('\n'));
          } else {
            await rm(deletedSource);
          }
          return result;
        },
        createAttempt: async () => {
          const attempt = await mkdtemp(join(root, '.agent-bundle', 'binding-attempt-'));
          attempts.push(attempt);
          return attempt;
        },
        createEpochId: () => `epoch-binding-${mutation}`,
        epochStore: store,
      });
      const result = await service.build(prepared);
      expect(result).toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'AB7101' })],
        outcome: 'failed',
      });
      await expect(store.readActiveEpoch()).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it('uses a root-independent digest for equivalent normalized project models', async () => {
  const leftRoot = await createProject();
  const rightRoot = await createProject();
  try {
    const [leftPrepared, rightPrepared] = await Promise.all([
      new ProjectService({ root: leftRoot }).prepare('build'),
      new ProjectService({ root: rightRoot }).prepare('build'),
    ]);
    const [left, right] = await Promise.all([
      new ArtifactService({ createEpochId: () => 'epoch-left', epochStore: new EpochStore({ projectRoot: leftRoot }) })
        .build(leftPrepared),
      new ArtifactService({ createEpochId: () => 'epoch-right', epochStore: new EpochStore({ projectRoot: rightRoot }) })
        .build(rightPrepared),
    ]);

    expect(left.outcome).toBe('succeeded');
    expect(right.outcome).toBe('succeeded');
    if (left.outcome !== 'succeeded' || right.outcome !== 'succeeded') throw new Error('Equivalent projects did not build.');
    expect(left.epoch.modelDigest).toBe(right.epoch.modelDigest);
  } finally {
    await Promise.all([
      rm(leftRoot, { force: true, recursive: true }),
      rm(rightRoot, { force: true, recursive: true }),
    ]);
  }
});

it('rejects a tampered staging transfer, retains the last good epoch, and cleans the failed attempt', async () => {
  const root = await createProject();
  const store = new EpochStore({ projectRoot: root });
  const attempts: string[] = [];
  const removedAttempts: string[] = [];
  const epochIds = ['epoch-good', 'epoch-tampered'];
  let tamperTransfer = false;

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    const prepared = await new ProjectService({ root }).prepare('build');
    const service = new ArtifactService({
      createAttempt: async () => {
        const attempt = await mkdtemp(join(root, '.agent-bundle', 'test-attempt-'));
        attempts.push(attempt);
        return attempt;
      },
      createEpochId: () => epochIds.shift() ?? 'unexpected-epoch',
      epochStore: store,
      move: async (source, destination) => {
        await rename(source, destination);
        if (tamperTransfer && source.endsWith('agent-bundle.manifest.json')) {
          await writeFile(join(destination, '..', 'unexpected.txt'), 'tampered\n');
        }
      },
      removeAttempt: async (path) => {
        removedAttempts.push(path);
        await rm(path, { force: true, recursive: true });
      },
    });

    const first = await service.build(prepared);
    tamperTransfer = true;
    const failed = await service.build(prepared);

    expect(first.outcome).toBe('succeeded');
    expect(failed).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB6004' })],
      outcome: 'failed',
    });
    if (first.outcome === 'succeeded') {
      expect(await store.readActiveEpoch()).toEqual(first.epoch);
    }
    expect(removedAttempts).toEqual(attempts);
    await expect(readFile(join(root, '.agent-bundle', 'epochs', 'epoch-tampered', 'portable', 'plugin.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
