import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

import {
  createRscEnvironmentCheckpointStore,
  rscRuntimeEnvironmentNames,
  type RscEnvironmentCheckpointStore,
  type RscEnvironmentCohortHashes,
} from '../src/dev/environment-checkpoint-store.js';
import {
  captureRuntimeGenerationSnapshot,
  materializeRuntimeGeneration,
  rscRuntimeGenerationMetadataCodec,
  validateRscRuntimeGenerationMetadata,
  validateStagedRscEnvironmentCheckpoint,
  type RscRuntimeGenerationMetadata,
} from '../src/dev/generation-materializer.js';
import { createRuntimeGenerationStore } from 'agent-bundle/api';
import { writeCompilerCohort } from './support/compiler-cohort.ts';

const preparedRuntime = Object.freeze({
  apps: Object.freeze([]),
  provider: './src/dev/provider.ts',
  servers: Object.freeze([]),
  sourceRevision: 'prepared-r1',
});

const cohortHashesFor = (suffix: string): RscEnvironmentCohortHashes => Object.freeze({
  app: `app-${suffix}`,
  rsc: `rsc-${suffix}`,
  widget: `widget-${suffix}`,
});

const createCheckpointStore = (root: string): RscEnvironmentCheckpointStore =>
  createRscEnvironmentCheckpointStore({
    root,
    validators: { rsc: validateStagedRscEnvironmentCheckpoint },
  });

const stageCohort = async (
  store: RscEnvironmentCheckpointStore,
  compilerRoot: string,
  suffix: string,
): Promise<RscEnvironmentCohortHashes> => {
  const hashes = cohortHashesFor(suffix);
  for (const environment of rscRuntimeEnvironmentNames) {
    await store.stage({ environment, hash: hashes[environment], sourceRoot: join(compilerRoot, environment) });
  }
  return hashes;
};

const settled = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });
  }
};

const waitForRemoval = async (path: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await readdir(path);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path} to be removed.`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
};

test('assembles a cohort only once every environment checkpoint has landed (skewed completion)', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-skew-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createCheckpointStore(join(storageRoot, 'environment-checkpoints'));
  try {
    await writeCompilerCohort(compilerRoot);
    const hashes = cohortHashesFor('one');
    // The global after-compile hook can fire before a slower environment's
    // own after-environment hook finishes staging; acquisition must wait for
    // the exact hash instead of reading anything mutable.
    await store.stage({ environment: 'app', hash: hashes.app, sourceRoot: join(compilerRoot, 'app') });
    await store.stage({ environment: 'rsc', hash: hashes.rsc, sourceRoot: join(compilerRoot, 'rsc') });
    let acquired = false;
    const pending = store.acquireCohort(hashes).then((cohort) => {
      acquired = true;
      return cohort;
    });
    await settled();
    expect(acquired).toBe(false);

    await store.stage({ environment: 'widget', hash: hashes.widget, sourceRoot: join(compilerRoot, 'widget') });
    const cohort = await pending;
    expect(acquired).toBe(true);
    expect(cohort.checkpoints.rsc.hash).toBe(hashes.rsc);
    expect(cohort.checkpoints.widget.files.get('rsc/index.html')).toMatch(/^[a-f0-9]{64}$/u);
    cohort.release();
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('fails a waiting cohort fast once a newer compilation supersedes the awaited hash', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-supersede-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createCheckpointStore(join(storageRoot, 'environment-checkpoints'));
  try {
    await writeCompilerCohort(compilerRoot);
    await store.stage({ environment: 'app', hash: 'app-one', sourceRoot: join(compilerRoot, 'app') });
    await store.stage({ environment: 'rsc', hash: 'rsc-one', sourceRoot: join(compilerRoot, 'rsc') });
    const waiting = store.acquireCohort(cohortHashesFor('one'));
    const observed = waiting.catch((error: unknown) => error);
    await settled();

    await store.stage({ environment: 'widget', hash: 'widget-two', sourceRoot: join(compilerRoot, 'widget') });
    await expect(observed).resolves.toMatchObject({
      message: expect.stringContaining('superseded by a newer compilation'),
    });

    // A cohort naming an already-superseded hash rejects immediately.
    await store.stage({ environment: 'widget', hash: 'widget-three', sourceRoot: join(compilerRoot, 'widget') });
    await expect(store.acquireCohort({ app: 'app-one', rsc: 'rsc-one', widget: 'widget-two' }))
      .rejects.toThrow('superseded by a newer compilation');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('rejects cohorts whose environment checkpoint failed to stage', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-staging-failure-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createCheckpointStore(join(storageRoot, 'environment-checkpoints'));
  try {
    await writeCompilerCohort(compilerRoot, { rscFiles: { 'undeclared.js': 'foreign-write' } });
    await store.stage({ environment: 'app', hash: 'app-one', sourceRoot: join(compilerRoot, 'app') });
    await store.stage({ environment: 'widget', hash: 'widget-one', sourceRoot: join(compilerRoot, 'widget') });
    await expect(store.stage({ environment: 'rsc', hash: 'rsc-one', sourceRoot: join(compilerRoot, 'rsc') }))
      .rejects.toThrow('undeclared');
    await expect(store.acquireCohort(cohortHashesFor('one'))).rejects.toThrow('failed to stage');

    // Failures recorded before staging could run reject waiters the same way.
    store.recordStagingFailure({ environment: 'rsc', error: new Error('emitted outside its session root'), hash: 'rsc-two' });
    await expect(store.acquireCohort({ app: 'app-one', rsc: 'rsc-two', widget: 'widget-one' }))
      .rejects.toThrow('failed to stage');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('keeps a pinned cohort immutable while newer compiles land, then garbage-collects it on release', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-gc-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const checkpointsRoot = join(storageRoot, 'environment-checkpoints');
  const store = createCheckpointStore(checkpointsRoot);
  const generationStore = createRuntimeGenerationStore<RscRuntimeGenerationMetadata>({
    metadataCodec: rscRuntimeGenerationMetadataCodec,
    storageRoot: join(storageRoot, 'generation-store'),
    validateMetadata: validateRscRuntimeGenerationMetadata,
  });
  try {
    await writeCompilerCohort(compilerRoot);
    const firstHashes = await stageCohort(store, compilerRoot, 'one');
    const cohort = await store.acquireCohort(firstHashes);
    const pinnedRscRoot = cohort.checkpoints.rsc.root;

    // Invalidation during assembly: a newer compile rewrites the live root
    // and stages fresh checkpoints while the acquired cohort is still being
    // copied. The pinned checkpoints stay intact.
    await writeFile(join(compilerRoot, 'rsc', 'rsc', 'index.js'), 'rewritten-by-next-compile', 'utf8');
    await stageCohort(store, compilerRoot, 'two');
    expect(await readFile(join(pinnedRscRoot, 'rsc', 'index.js'), 'utf8')).toBe('rsc-entry');

    const candidate = await generationStore.begin({ id: 'gc-generation', sourceRevision: 'source-gc' });
    const snapshot = await captureRuntimeGenerationSnapshot({
      attemptId: 'attempt-gc',
      candidate,
      cohort: cohort.checkpoints,
      preparedRuntime,
      rscCohortRevision: 1,
      sourceRevision: 'source-gc',
    });
    const prepared = await materializeRuntimeGeneration({ snapshot, store: generationStore });
    expect(await readFile(join(prepared.generation.root, 'rsc', 'rsc', 'index.js'), 'utf8')).toBe('rsc-entry');

    // Releasing the pins garbage-collects the superseded checkpoints without
    // touching the admitted generation candidate's copied bytes.
    cohort.release();
    await waitForRemoval(pinnedRscRoot);
    expect(await readFile(join(prepared.generation.root, 'rsc', 'rsc', 'index.js'), 'utf8')).toBe('rsc-entry');
    const remaining = await readdir(checkpointsRoot);
    expect(remaining.some((entry) => entry.startsWith('rsc-'))).toBe(true);

    const secondCohort = await store.acquireCohort(cohortHashesFor('two'));
    expect(await readFile(join(secondCohort.checkpoints.rsc.root, 'rsc', 'index.js'), 'utf8')).toBe('rewritten-by-next-compile');
    secondCohort.release();
  } finally {
    await generationStore.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('deduplicates unchanged-hash restaging onto the same immutable checkpoint', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-dedupe-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const checkpointsRoot = join(storageRoot, 'environment-checkpoints');
  const store = createCheckpointStore(checkpointsRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    await store.stage({ environment: 'widget', hash: 'widget-one', sourceRoot: join(compilerRoot, 'widget') });
    // An unchanged environment reports the same hash on later watch cycles;
    // restaging must reuse the existing checkpoint instead of copying again.
    await store.stage({ environment: 'widget', hash: 'widget-one', sourceRoot: join(compilerRoot, 'widget') });
    const staged = await readdir(checkpointsRoot);
    expect(staged.filter((entry) => entry.startsWith('widget-'))).toHaveLength(1);
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('close rejects when a garbage-collected checkpoint directory cannot be removed', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-rm-failure-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const checkpointsRoot = join(storageRoot, 'environment-checkpoints');
  const store = createCheckpointStore(checkpointsRoot);
  let pinnedRoot: string | undefined;
  try {
    await writeCompilerCohort(compilerRoot);
    await store.stage({ environment: 'widget', hash: 'widget-one', sourceRoot: join(compilerRoot, 'widget') });
    const staged = await readdir(checkpointsRoot);
    pinnedRoot = join(checkpointsRoot, staged.find((entry) => entry.startsWith('widget-'))!);
    // A read-only subdirectory makes every removal of this checkpoint fail,
    // both the supersession GC attempt and the close-time retry.
    await chmod(join(pinnedRoot, 'rsc'), 0o555);
    await store.stage({ environment: 'widget', hash: 'widget-two', sourceRoot: join(compilerRoot, 'widget') });
    await expect(store.close()).rejects.toThrow('could not remove staged directories');
  } finally {
    if (pinnedRoot !== undefined) await chmod(join(pinnedRoot, 'rsc'), 0o755).catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('close retries a transiently failed checkpoint removal before reporting a clean drain', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-rm-retry-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const checkpointsRoot = join(storageRoot, 'environment-checkpoints');
  const store = createCheckpointStore(checkpointsRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    await store.stage({ environment: 'widget', hash: 'widget-one', sourceRoot: join(compilerRoot, 'widget') });
    const staged = await readdir(checkpointsRoot);
    const supersededRoot = join(checkpointsRoot, staged.find((entry) => entry.startsWith('widget-'))!);
    await chmod(join(supersededRoot, 'rsc'), 0o555);
    await store.stage({ environment: 'widget', hash: 'widget-two', sourceRoot: join(compilerRoot, 'widget') });
    // Let the failed GC removal settle while the directory is still
    // read-only, then clear the transient condition: the close-time retry
    // must remove the directory and report a clean drain.
    await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
    expect((await readdir(checkpointsRoot)).includes(supersededRoot.slice(checkpointsRoot.length + 1))).toBe(true);
    await chmod(join(supersededRoot, 'rsc'), 0o755);
    await store.close();
    const remaining = await readdir(checkpointsRoot).catch(() => []);
    expect(remaining.filter((entry) => entry.startsWith('widget-'))).toEqual([]);
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('close waits for in-flight staging work before reporting the store drained', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-inflight-close-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const checkpointsRoot = join(storageRoot, 'environment-checkpoints');
  let enteredValidator!: () => void;
  const entered = new Promise<void>((resolve) => { enteredValidator = resolve; });
  let releaseValidator!: () => void;
  const hold = new Promise<void>((resolve) => { releaseValidator = resolve; });
  const store = createRscEnvironmentCheckpointStore({
    root: checkpointsRoot,
    validators: {
      widget: async (input) => {
        enteredValidator();
        await hold;
        return input.files;
      },
    },
  });
  try {
    await writeCompilerCohort(compilerRoot);
    const staging = store.stage({ environment: 'widget', hash: 'widget-one', sourceRoot: join(compilerRoot, 'widget') });
    const stagingOutcome = staging.catch((error: unknown) => error);
    await entered;
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await settled();
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    // The staging copy (held inside its validator) still owns filesystem
    // work; close must not report the store drained yet.
    expect(closed).toBe(false);
    releaseValidator();
    await closing;
    await expect(stagingOutcome).resolves.toMatchObject({
      message: expect.stringContaining('closed'),
    });
    // The in-flight staging directory was cleaned before close resolved.
    const remaining = await readdir(checkpointsRoot).catch(() => []);
    expect(remaining).toEqual([]);
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('close rejects pending cohort waiters and removes staged checkpoints', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-checkpoints-close-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const checkpointsRoot = join(storageRoot, 'environment-checkpoints');
  const store = createCheckpointStore(checkpointsRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    await stageCohort(store, compilerRoot, 'one');
    const waiting = store.acquireCohort(cohortHashesFor('two'));
    const observed = waiting.catch((error: unknown) => error);
    await store.close();
    await expect(observed).resolves.toMatchObject({
      message: expect.stringContaining('closed'),
    });
    for (const entry of await readdir(checkpointsRoot).catch(() => [])) {
      throw new Error(`Staged checkpoint ${entry} survived close.`);
    }
    await expect(store.stage({ environment: 'widget', hash: 'widget-three', sourceRoot: join(compilerRoot, 'widget') }))
      .rejects.toThrow('closed');
    await expect(store.acquireCohort(cohortHashesFor('one'))).rejects.toThrow('closed');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});
