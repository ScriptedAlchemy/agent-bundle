import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { EpochStore } from '../src/dev/epoch-store.ts';
import {
  DevCoordinator,
  DevCoordinatorCloseError,
  ProjectEventHub,
  ProjectService,
  type ArtifactEpoch,
  type ArtifactEpochResult,
  type DiagnosticReport,
  type Invalidation,
  type PreparedProject,
} from '../src/dev/index.ts';

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-coordinator-'));
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'dev-coordinator-fixture', version: '1.0.0' },",
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

const epochFor = (root: string, id: string, projectRevision: string): ArtifactEpoch => ({
  configDigest: `${id}-config`,
  createdAt: '2026-08-14T12:00:00.000Z',
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: join(root, '.agent-bundle', 'epochs', id, 'agent-bundle.manifest.json'),
  modelDigest: `${id}-model`,
  projectRevision,
  targetDigests: { portable: `${id}-portable` },
});

const succeeded = (epoch: ArtifactEpoch): ArtifactEpochResult => ({
  diagnostics: [],
  epoch,
  outcome: 'succeeded',
});

const failed = (): ArtifactEpochResult => ({
  diagnostics: [{
    code: 'AB7100',
    message: 'Compiler failed.',
    severity: 'error',
  }],
  outcome: 'failed',
});

const invalidation = (paths: readonly string[]): Invalidation => ({
  occurredAt: '2026-08-14T12:00:00.000Z',
  paths,
  reason: 'source-change',
});

it('serializes a running build and coalesces all concurrent invalidations into one follow-up', async () => {
  const root = await createProject();
  let releaseFirstBuild: (() => void) | undefined;
  const firstBuild = new Promise<void>((resolvePromise) => {
    releaseFirstBuild = resolvePromise;
  });
  let signalFirstBuild: (() => void) | undefined;
  const firstBuildStarted = new Promise<void>((resolvePromise) => {
    signalFirstBuild = resolvePromise;
  });
  const buildCalls: PreparedProject[] = [];
  const lintPaths: (readonly string[])[] = [];
  const events: string[] = [];
  const hub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  hub.subscribe((event) => {
    if (event.type !== 'replay.gap') events.push(event.type);
  });

  try {
    const projectService = new ProjectService({ root });
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => undefined }),
      artifactService: {
        build: async (prepared) => {
          buildCalls.push(prepared);
          if (buildCalls.length === 1) {
            signalFirstBuild?.();
            await firstBuild;
          }
          return succeeded(epochFor(root, `epoch-${buildCalls.length}`, prepared.source.revision ?? 'missing'));
        },
      },
      createAttemptId: (() => {
        let count = 0;
        return () => `attempt-${++count}`;
      })(),
      diagnosticService: {
        close: async () => undefined,
        lint: async (paths): Promise<DiagnosticReport> => {
          lintPaths.push(paths);
          return { diagnostics: [], paths };
        },
      },
      epochStore: new EpochStore({ projectRoot: root }),
      eventHub: hub,
      projectService,
      root,
    });

    const starting = coordinator.start();
    await firstBuildStarted;
    const second = coordinator.rebuild(invalidation(['src/second.ts', 'src/first.ts']));
    const third = coordinator.rebuild(invalidation(['src/third.ts', 'src/second.ts']));
    releaseFirstBuild?.();

    const [session, secondResult, thirdResult] = await Promise.all([starting, second, third]);

    expect(session.status().artifact).toMatchObject({ state: 'active' });
    expect(secondResult.outcome).toBe('succeeded');
    expect(thirdResult.outcome).toBe('succeeded');
    expect(buildCalls).toHaveLength(2);
    expect(lintPaths).toEqual([[], ['src/first.ts', 'src/second.ts', 'src/third.ts']]);
    expect(events.filter((type) => type === 'build.started')).toHaveLength(2);
    expect(events.filter((type) => type === 'invalidation')).toHaveLength(2);
    await coordinator.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains the last good epoch as stale when a later rebuild fails', async () => {
  const root = await createProject();
  const hub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  const events: string[] = [];
  hub.subscribe((event) => {
    if (event.type !== 'replay.gap') events.push(event.type);
  });
  let buildCount = 0;

  try {
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => undefined }),
      artifactService: {
        build: async (prepared) => {
          buildCount += 1;
          return buildCount === 1
            ? succeeded(epochFor(root, 'epoch-good', prepared.source.revision ?? 'missing'))
            : failed();
        },
      },
      diagnosticService: {
        close: async () => undefined,
        lint: async (paths) => ({ diagnostics: [], paths }),
      },
      epochStore: new EpochStore({ projectRoot: root }),
      eventHub: hub,
      projectService: new ProjectService({ root }),
      root,
    });

    await coordinator.start();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'broken.ts'), 'export const broken = true;\n');
    const result = await coordinator.rebuild(invalidation(['src/broken.ts']));

    expect(result.outcome).toBe('failed');
    expect(coordinator.status()).toMatchObject({
      artifact: { activeEpoch: { id: 'epoch-good' }, state: 'stale' },
      build: { lastAttempt: { outcome: 'failed' }, state: 'failed' },
    });
    expect(events).toEqual(expect.arrayContaining(['artifact.available', 'build.failed', 'artifact.status']));
    await coordinator.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('waits for an in-flight build and closes watcher, diagnostics, and lock exactly once', async () => {
  const root = await createProject();
  let releaseBuild: (() => void) | undefined;
  const buildReleased = new Promise<void>((resolvePromise) => {
    releaseBuild = resolvePromise;
  });
  let signalBuildStarted: (() => void) | undefined;
  const buildStarted = new Promise<void>((resolvePromise) => {
    signalBuildStarted = resolvePromise;
  });
  let lockCloses = 0;
  let diagnosticCloses = 0;
  let watcherCloses = 0;

  try {
    const options = {
      acquireLock: async () => ({ close: async () => { lockCloses += 1; } }),
      artifactService: {
        build: async (prepared: PreparedProject) => {
          signalBuildStarted?.();
          await buildReleased;
          return succeeded(epochFor(root, 'epoch-close', prepared.source.revision ?? 'missing'));
        },
      },
      createWatcher: () => ({
        close: async () => { watcherCloses += 1; },
      }),
      diagnosticService: {
        close: async () => { diagnosticCloses += 1; },
        lint: async (paths: readonly string[]) => ({ diagnostics: [], paths }),
      },
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    };
    const coordinator = new DevCoordinator(options);
    const starting = coordinator.start();
    await buildStarted;
    const firstClose = coordinator.close();
    const secondClose = coordinator.close();

    expect(firstClose).toBe(secondClose);
    await Promise.resolve();
    await Promise.resolve();
    expect([watcherCloses, diagnosticCloses, lockCloses]).toEqual([0, 0, 0]);
    releaseBuild?.();
    await Promise.all([starting, firstClose]);

    expect([watcherCloses, diagnosticCloses, lockCloses]).toEqual([1, 1, 1]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports every failed release structurally after closing the remaining resources', async () => {
  const root = await createProject();
  const diagnosticFailure = new Error('diagnostics release failed');
  const lockFailure = new Error('lock release failed');
  const watcherFailure = new Error('watcher release failed');
  const closed: string[] = [];

  try {
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({
        close: async () => {
          closed.push('lock');
          throw lockFailure;
        },
      }),
      artifactService: {
        build: async (prepared) => succeeded(epochFor(root, 'epoch-errors', prepared.source.revision ?? 'missing')),
      },
      createWatcher: () => ({
        close: async () => {
          closed.push('watcher');
          throw watcherFailure;
        },
      }),
      diagnosticService: {
        close: async () => {
          closed.push('diagnostics');
          throw diagnosticFailure;
        },
        lint: async (paths) => ({ diagnostics: [], paths }),
      },
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });

    await coordinator.start();
    let closeFailure: unknown;
    try {
      await coordinator.close();
    } catch (error) {
      closeFailure = error;
    }

    expect(closed.sort()).toEqual(['diagnostics', 'lock', 'watcher']);
    expect(closeFailure).toBeInstanceOf(DevCoordinatorCloseError);
    if (!(closeFailure instanceof DevCoordinatorCloseError)) throw closeFailure;
    expect(closeFailure.failures).toEqual(expect.arrayContaining([
      { error: diagnosticFailure, resource: 'diagnostics' },
      { error: lockFailure, resource: 'lock' },
      { error: watcherFailure, resource: 'watcher' },
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
