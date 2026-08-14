import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { EpochStore } from '../src/dev/epoch-store.ts';
import {
  ArtifactService,
  DevCoordinator,
  DevCoordinatorCloseError,
  ProjectEventHub,
  ProjectService,
  ProjectWatcher,
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

class EventSourceWatcher {
  readonly #listeners = new Map<string, readonly ((path: string) => void)[]>();

  close(): Promise<void> {
    return Promise.resolve();
  }

  emit(event: string, path: string): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(path);
  }

  on(event: string, listener: (path: string) => void): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }
}

class BlockingRecoveryEpochStore extends EpochStore {
  readonly #gate: Promise<void>;
  readonly #onBlocked: () => void;

  constructor(options: { readonly gate: Promise<void>; readonly onBlocked: () => void; readonly projectRoot: string }) {
    super({ projectRoot: options.projectRoot });
    this.#gate = options.gate;
    this.#onBlocked = options.onBlocked;
  }

  override async recoverStaging(): Promise<void> {
    this.#onBlocked();
    await this.#gate;
    await super.recoverStaging();
  }
}

class BlockingActiveEpochStore extends EpochStore {
  readonly #gate: Promise<void>;
  readonly #onBlocked: () => void;

  constructor(options: { readonly gate: Promise<void>; readonly onBlocked: () => void; readonly projectRoot: string }) {
    super({ projectRoot: options.projectRoot });
    this.#gate = options.gate;
    this.#onBlocked = options.onBlocked;
  }

  override async readActiveEpoch() {
    this.#onBlocked();
    await this.#gate;
    return super.readActiveEpoch();
  }
}

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
          if (buildCalls.length === 2) {
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

    await coordinator.start();
    const first = coordinator.rebuild(invalidation(['src/running.ts']));
    await firstBuildStarted;
    const second = coordinator.rebuild(invalidation(['src/second.ts', 'src/first.ts']));
    const third = coordinator.rebuild(invalidation(['src/third.ts', 'src/second.ts']));
    releaseFirstBuild?.();

    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);

    expect(firstResult.outcome).toBe('succeeded');
    expect(coordinator.status().artifact).toMatchObject({ state: 'active' });
    expect(secondResult.outcome).toBe('succeeded');
    expect(thirdResult.outcome).toBe('succeeded');
    expect(buildCalls).toHaveLength(3);
    expect(lintPaths).toEqual([[], ['src/running.ts'], ['src/first.ts', 'src/second.ts', 'src/third.ts']]);
    expect(events.filter((type) => type === 'build.started')).toHaveLength(3);
    expect(events.filter((type) => type === 'invalidation')).toHaveLength(3);
    await coordinator.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('queues watcher add, change, and delete paths as one rebuild during a running build', async () => {
  const root = await createProject();
  const sourceWatcher = new EventSourceWatcher();
  let projectWatcher: ProjectWatcher | undefined;
  let releaseFirstBuild: (() => void) | undefined;
  const firstBuild = new Promise<void>((resolvePromise) => {
    releaseFirstBuild = resolvePromise;
  });
  let signalFirstBuild: (() => void) | undefined;
  const firstBuildStarted = new Promise<void>((resolvePromise) => {
    signalFirstBuild = resolvePromise;
  });
  const lintPaths: (readonly string[])[] = [];
  let builds = 0;

  try {
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => undefined }),
      artifactService: {
        build: async (prepared) => {
          builds += 1;
          if (builds === 2) {
            signalFirstBuild?.();
            await firstBuild;
          }
          return succeeded(epochFor(root, `epoch-watcher-${builds}`, prepared.source.revision ?? 'missing'));
        },
      },
      createWatcher: (options) => {
        projectWatcher = new ProjectWatcher({
          ...options,
          createWatcher: () => sourceWatcher,
          debounceMs: 60_000,
        });
        return projectWatcher;
      },
      diagnosticService: {
        close: async () => undefined,
        lint: async (paths) => {
          lintPaths.push(paths);
          return { diagnostics: [], paths };
        },
      },
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });

    await coordinator.start();
    const running = coordinator.rebuild(invalidation(['src/running.ts']));
    await firstBuildStarted;
    if (projectWatcher === undefined) throw new Error('Coordinator did not create its watcher.');
    sourceWatcher.emit('add', join(root, 'src', 'added.ts'));
    sourceWatcher.emit('change', join(root, 'src', 'changed.ts'));
    sourceWatcher.emit('unlink', join(root, 'src', 'added.ts'));
    const followup = projectWatcher.flush();
    releaseFirstBuild?.();
    await Promise.all([running, followup]);

    expect(builds).toBe(3);
    expect(lintPaths).toEqual([[], ['src/running.ts'], ['src/added.ts', 'src/changed.ts']]);
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

it('does not build until its watcher is ready and forwards project watcher exclusions', async () => {
  const root = await createProject();
  await writeFile(join(root, '.gitignore'), 'ignored-by-gitignore/\n');
  let releaseWatcherReady: (() => void) | undefined;
  const watcherReady = new Promise<void>((resolvePromise) => {
    releaseWatcherReady = resolvePromise;
  });
  let signalWatcherCreated: (() => void) | undefined;
  const watcherCreated = new Promise<void>((resolvePromise) => {
    signalWatcherCreated = resolvePromise;
  });
  let watcherOptions: unknown;
  let buildCalls = 0;

  try {
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => undefined }),
      artifactService: {
        build: async (prepared) => {
          buildCalls += 1;
          return succeeded(epochFor(root, 'epoch-watcher-ready', prepared.source.revision ?? 'missing'));
        },
      },
      createWatcher: (options) => {
        watcherOptions = options;
        signalWatcherCreated?.();
        return {
          close: async () => undefined,
          ready: async () => watcherReady,
        };
      },
      diagnosticService: {
        close: async () => undefined,
        lint: async (paths) => ({ diagnostics: [], paths }),
      },
      epochStore: new EpochStore({ projectRoot: root }),
      ignoredPaths: ['private-generated'],
      outputPaths: ['published-output'],
      projectService: new ProjectService({ root }),
      root,
    });

    const starting = coordinator.start();
    await watcherCreated;
    expect(buildCalls).toBe(0);
    expect(watcherOptions).toMatchObject({
      ignoredPaths: ['private-generated'],
      outputPaths: ['published-output'],
    });
    const ignored = Reflect.get(watcherOptions as object, 'isIgnored');
    expect(ignored).toBeTypeOf('function');
    if (typeof ignored !== 'function') throw new Error('Coordinator did not pass project ignore rules to its watcher.');
    expect(ignored(join(root, 'ignored-by-gitignore', 'file.ts'))).toBe(true);

    releaseWatcherReady?.();
    await starting;
    expect(buildCalls).toBe(1);
    await coordinator.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects public rebuild requests before startup without preparing or publishing', async () => {
  const root = await createProject();
  let builds = 0;
  try {
    const coordinator = new DevCoordinator({
      artifactService: {
        build: async (prepared) => {
          builds += 1;
          return succeeded(epochFor(root, 'unexpected', prepared.source.revision ?? 'missing'));
        },
      },
      diagnosticService: { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });

    const result = await coordinator.rebuild(invalidation(['src/early.ts']));
    expect(result).toMatchObject({ diagnostics: [expect.objectContaining({ code: 'AB7200' })], outcome: 'failed' });
    expect(builds).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects public rebuilds until startup has completed watcher readiness', async () => {
  const root = await createProject();
  let releaseWatcherReady: (() => void) | undefined;
  const watcherReady = new Promise<void>((resolvePromise) => {
    releaseWatcherReady = resolvePromise;
  });
  let signalWatcherCreated: (() => void) | undefined;
  const watcherCreated = new Promise<void>((resolvePromise) => {
    signalWatcherCreated = resolvePromise;
  });
  let prepares = 0;
  let builds = 0;
  let starting: Promise<unknown> | undefined;

  try {
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => undefined }),
      artifactService: {
        build: async (prepared) => {
          builds += 1;
          return succeeded(epochFor(root, `epoch-ready-${builds}`, prepared.source.revision ?? 'missing'));
        },
      },
      createWatcher: () => {
        signalWatcherCreated?.();
        return { close: async () => undefined, ready: async () => watcherReady };
      },
      diagnosticService: { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: {
        prepare: async () => {
          prepares += 1;
          return new ProjectService({ root }).prepare('build');
        },
      },
      root,
    });

    starting = coordinator.start();
    await watcherCreated;
    const publicResult = await coordinator.rebuild(invalidation(['src/too-early.ts']));
    expect(publicResult).toMatchObject({ diagnostics: [expect.objectContaining({ code: 'AB7200' })], outcome: 'failed' });
    expect([prepares, builds]).toEqual([0, 0]);

    releaseWatcherReady?.();
    await starting;
    expect([prepares, builds]).toEqual([1, 1]);
    const afterStart = await coordinator.rebuild(invalidation(['src/after-start.ts']));
    expect(afterStart.outcome).toBe('succeeded');
    expect([prepares, builds]).toEqual([2, 2]);
    await coordinator.close();
  } finally {
    releaseWatcherReady?.();
    await starting?.catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('does not enable public rebuilds when startup fails before readiness', async () => {
  const root = await createProject();
  let prepares = 0;
  try {
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => undefined }),
      createWatcher: () => ({
        close: async () => undefined,
        ready: async () => { throw new Error('watcher failed before ready'); },
      }),
      diagnosticService: { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: {
        prepare: async () => {
          prepares += 1;
          return new ProjectService({ root }).prepare('build');
        },
      },
      root,
    });

    await expect(coordinator.start()).rejects.toThrow('watcher failed before ready');
    const result = await coordinator.rebuild(invalidation(['src/after-failed-start.ts']));
    expect(result).toMatchObject({ diagnostics: [expect.objectContaining({ code: 'AB7200' })], outcome: 'failed' });
    expect(prepares).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('cancels blocked startup readiness and releases its watcher and lock before close resolves', async () => {
  const root = await createProject();
  let releaseWatcherReady: (() => void) | undefined;
  const watcherReady = new Promise<void>((resolvePromise) => {
    releaseWatcherReady = resolvePromise;
  });
  let signalWatcherCreated: (() => void) | undefined;
  const watcherCreated = new Promise<void>((resolvePromise) => {
    signalWatcherCreated = resolvePromise;
  });
  let watcherCloses = 0;
  let lockCloses = 0;

  try {
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => { lockCloses += 1; } }),
      createWatcher: () => {
        signalWatcherCreated?.();
        return {
          close: async () => { watcherCloses += 1; },
          ready: async () => watcherReady,
        };
      },
      diagnosticService: { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });

    const starting = coordinator.start();
    await watcherCreated;
    await coordinator.close();
    expect([watcherCloses, lockCloses]).toEqual([1, 1]);
    await expect(starting).rejects.toThrow('DevCoordinator is closed.');
  } finally {
    releaseWatcherReady?.();
    await rm(root, { force: true, recursive: true });
  }
});

it('cancels blocked startup recovery without creating later watcher or build state', async () => {
  const root = await createProject();
  let releaseRecovery: (() => void) | undefined;
  const recovery = new Promise<void>((resolvePromise) => {
    releaseRecovery = resolvePromise;
  });
  let signalRecoveryBlocked: (() => void) | undefined;
  const recoveryBlocked = new Promise<void>((resolvePromise) => {
    signalRecoveryBlocked = resolvePromise;
  });
  let builds = 0;
  let lockCloses = 0;
  let watcherCreates = 0;
  const events: string[] = [];

  try {
    const hub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
    hub.subscribe((event) => {
      if (event.type !== 'replay.gap') events.push(event.type);
    });
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => { lockCloses += 1; } }),
      artifactService: { build: async (prepared) => {
        builds += 1;
        return succeeded(epochFor(root, 'unexpected-recovery', prepared.source.revision ?? 'missing'));
      } },
      createWatcher: () => {
        watcherCreates += 1;
        return { close: async () => undefined };
      },
      diagnosticService: { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
      epochStore: new BlockingRecoveryEpochStore({
        gate: recovery,
        onBlocked: () => signalRecoveryBlocked?.(),
        projectRoot: root,
      }),
      eventHub: hub,
      projectService: new ProjectService({ root }),
      root,
    });

    const starting = coordinator.start();
    await recoveryBlocked;
    await coordinator.close();
    expect([lockCloses, watcherCreates, builds]).toEqual([1, 0, 0]);
    await expect(starting).rejects.toThrow('DevCoordinator is closed.');
    releaseRecovery?.();
    await Promise.resolve();
    expect([watcherCreates, builds, events]).toEqual([0, 0, []]);
  } finally {
    releaseRecovery?.();
    await rm(root, { force: true, recursive: true });
  }
});

it('cancels blocked active epoch recovery without creating later watcher or build state', async () => {
  const root = await createProject();
  let releaseActiveRead: (() => void) | undefined;
  const activeRead = new Promise<void>((resolvePromise) => {
    releaseActiveRead = resolvePromise;
  });
  let signalActiveReadBlocked: (() => void) | undefined;
  const activeReadBlocked = new Promise<void>((resolvePromise) => {
    signalActiveReadBlocked = resolvePromise;
  });
  let builds = 0;
  let lockCloses = 0;
  let watcherCreates = 0;
  const events: string[] = [];

  try {
    const hub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
    hub.subscribe((event) => {
      if (event.type !== 'replay.gap') events.push(event.type);
    });
    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => { lockCloses += 1; } }),
      artifactService: { build: async (prepared) => {
        builds += 1;
        return succeeded(epochFor(root, 'unexpected-active-read', prepared.source.revision ?? 'missing'));
      } },
      createWatcher: () => {
        watcherCreates += 1;
        return { close: async () => undefined };
      },
      diagnosticService: { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
      epochStore: new BlockingActiveEpochStore({
        gate: activeRead,
        onBlocked: () => signalActiveReadBlocked?.(),
        projectRoot: root,
      }),
      eventHub: hub,
      projectService: new ProjectService({ root }),
      root,
    });

    const starting = coordinator.start();
    await activeReadBlocked;
    await coordinator.close();
    expect([lockCloses, watcherCreates, builds]).toEqual([1, 0, 0]);
    await expect(starting).rejects.toThrow('DevCoordinator is closed.');
    releaseActiveRead?.();
    await Promise.resolve();
    expect([watcherCreates, builds, events]).toEqual([0, 0, []]);
  } finally {
    releaseActiveRead?.();
    await rm(root, { force: true, recursive: true });
  }
});

it('loads the active epoch before a failed initial build and retains it as stale', async () => {
  const root = await createProject();
  const store = new EpochStore({ projectRoot: root });
  try {
    const project = new ProjectService({ root });
    const seeded = await new ArtifactService({ createEpochId: () => 'epoch-existing', epochStore: store })
      .build(await project.prepare('build'));
    expect(seeded.outcome).toBe('succeeded');
    if (seeded.outcome !== 'succeeded') throw new Error('The seed epoch did not publish.');
    await writeFile(join(root, 'source-changed.ts'), 'export const changed = true;\n');

    const coordinator = new DevCoordinator({
      acquireLock: async () => ({ close: async () => undefined }),
      artifactService: { build: async () => failed() },
      createWatcher: () => ({ close: async () => undefined }),
      diagnosticService: { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
      epochStore: store,
      projectService: project,
      root,
    });

    const session = await coordinator.start();
    expect(session.status()).toMatchObject({
      artifact: { activeEpoch: { id: 'epoch-existing' }, state: 'stale' },
      build: { lastAttempt: { outcome: 'failed' }, state: 'failed' },
    });
    await session.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('turns prepare, lint, and artifact rejections into failed attempts and events', async () => {
  const phases = ['prepare', 'lint', 'artifact'] as const;
  for (const phase of phases) {
    const root = await createProject();
    const hub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
    const events: string[] = [];
    hub.subscribe((event) => {
      if (event.type !== 'replay.gap') events.push(event.type);
    });
    try {
      const coordinator = new DevCoordinator({
        acquireLock: async () => ({ close: async () => undefined }),
        artifactService: phase === 'artifact'
          ? { build: async () => { throw new Error('artifact rejection'); } }
          : { build: async (prepared) => succeeded(epochFor(root, `epoch-${phase}`, prepared.source.revision ?? 'missing')) },
        createWatcher: () => ({ close: async () => undefined }),
        diagnosticService: phase === 'lint'
          ? { close: async () => undefined, lint: async () => { throw new Error('lint rejection'); } }
          : { close: async () => undefined, lint: async (paths) => ({ diagnostics: [], paths }) },
        epochStore: new EpochStore({ projectRoot: root }),
        eventHub: hub,
        projectService: phase === 'prepare'
          ? { prepare: async () => { throw new Error('prepare rejection'); } }
          : new ProjectService({ root }),
        root,
      });

      const session = await coordinator.start();
      expect(session.status()).toMatchObject({ build: { lastAttempt: { outcome: 'failed' }, state: 'failed' } });
      expect(events).toEqual(expect.arrayContaining(['build.failed', 'artifact.status']));
      await session.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});
