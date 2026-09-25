import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { expect, test } from '@rstest/core';

import {
  createRscRuntimeRsbuildConfig,
  type RscRuntimeCompileSnapshot,
} from '../rsbuild.config.js';
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
  type RscRuntimeCapturedGenerationSnapshot,
  type RscRuntimeGenerationMetadata,
} from '../src/dev/generation-materializer.js';
import { createRuntimeGenerationStore, type DevRuntimeGenerationStore, type DevRuntimePreparedProject, type RuntimeGenerationCandidate } from 'agent-bundle/api';
// Test-only wiring: the digest helpers are not part of the provider protocol.
import { digest, stableJson } from '../../../packages/agent-bundle/src/core/digest.ts';
import { writeCompilerCohort } from './support/compiler-cohort.ts';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const preparedRuntime = Object.freeze({
  provider: './src/dev/provider.ts',
  servers: Object.freeze([]),
  sourceRevision: 'prepared-r1',
});

const createStore = (storageRoot: string): DevRuntimeGenerationStore<RscRuntimeGenerationMetadata> =>
  createRuntimeGenerationStore({
    metadataCodec: rscRuntimeGenerationMetadataCodec,
    now: () => new Date('2026-08-15T00:00:00.000Z'),
    storageRoot,
    validateMetadata: validateRscRuntimeGenerationMetadata,
  });

const rewriteGenerationManifest = async (
  root: string,
  mutateMetadata: (metadata: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): Promise<void> => {
  const manifestPath = join(root, 'generation.manifest.json');
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
    !('metadata' in parsed) || typeof parsed.metadata !== 'object' || parsed.metadata === null || Array.isArray(parsed.metadata)) {
    throw new TypeError('Test generation manifest was malformed.');
  }
  const { manifestDigest: _manifestDigest, ...withoutDigest } = parsed as Readonly<Record<string, unknown>>;
  const updated = Object.freeze({ ...withoutDigest, metadata: mutateMetadata(parsed.metadata as Readonly<Record<string, unknown>>) });
  await writeFile(manifestPath, stableJson({ ...updated, manifestDigest: digest(updated) }), 'utf8');
};

const createCheckpointStore = (root: string): RscEnvironmentCheckpointStore =>
  createRscEnvironmentCheckpointStore({
    root,
    validators: { rsc: validateStagedRscEnvironmentCheckpoint },
  });

const cohortHashesFor = (suffix: string): RscEnvironmentCohortHashes => Object.freeze({
  rsc: `rsc-${suffix}`,
  widget: `widget-${suffix}`,
});

const stageCompilerCohort = async (
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

let ephemeralCheckpointSequence = 0;

/**
 * Stages the current live compiler trees as immutable checkpoints and
 * captures the candidate from them, mirroring the session's staged-cohort
 * flow. Passing `checkpointStore` keeps one validated staging chain across
 * successive captures; otherwise an ephemeral store is used.
 */
const captureCompilerCohort = async (input: Readonly<{
  readonly attemptId: string;
  readonly candidate: RuntimeGenerationCandidate;
  readonly checkpointStore?: RscEnvironmentCheckpointStore;
  readonly cohortSuffix?: string;
  readonly compilerRoot: string;
  readonly preparedRuntime: DevRuntimePreparedProject;
  readonly rscCohortRevision: number;
  readonly sourceRevision: string;
}>): Promise<RscRuntimeCapturedGenerationSnapshot> => {
  const store = input.checkpointStore ?? createCheckpointStore(
    join(input.compilerRoot, '..', `environment-checkpoints-${String(++ephemeralCheckpointSequence)}`),
  );
  try {
    const hashes = await stageCompilerCohort(store, input.compilerRoot, input.cohortSuffix ?? input.sourceRevision);
    const cohort = await store.acquireCohort(hashes);
    try {
      return await captureRuntimeGenerationSnapshot({
        attemptId: input.attemptId,
        candidate: input.candidate,
        cohort: cohort.checkpoints,
        preparedRuntime: input.preparedRuntime,
        rscCohortRevision: input.rscCohortRevision,
        sourceRevision: input.sourceRevision,
      });
    } finally {
      cohort.release();
    }
  } finally {
    if (input.checkpointStore === undefined) await store.close();
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

type CompileObserverContract = NonNullable<Parameters<typeof createRscRuntimeRsbuildConfig>[0]['onCompile']>;

const activateCompilerObserver = (
  onCompile: Omit<CompileObserverContract, 'stageEnvironmentCheckpoint'> & Partial<Pick<CompileObserverContract, 'stageEnvironmentCheckpoint'>>,
) => {
  const config = createRscRuntimeRsbuildConfig({
    compilerRoot: join(tmpdir(), 'rsc-agent-runtime-observer'),
    mode: 'development',
    onCompile: {
      stageEnvironmentCheckpoint: async () => undefined,
      ...onCompile,
    },
  });
  const plugin = (config.plugins as readonly unknown[]).find((value): value is Readonly<{
    readonly name: string;
    setup(api: unknown): void;
  }> => typeof value === 'object' && value !== null && 'name' in value && (value as { name?: unknown }).name === 'agent-bundle:rsc-runtime-compile-observer');
  if (plugin === undefined) throw new Error('Compile observer plugin was not configured.');

  let before: (() => void) | undefined;
  let after: ((input: unknown) => Promise<void>) | undefined;
  let afterEnvironment: ((input: unknown) => Promise<void>) | undefined;
  plugin.setup({
    onAfterDevCompile: (callback: unknown) => { after = callback as (input: unknown) => Promise<void>; },
    onAfterEnvironmentCompile: (callback: unknown) => { afterEnvironment = callback as (input: unknown) => Promise<void>; },
    onBeforeDevCompile: (callback: unknown) => { before = callback as () => void; },
  });
  return Object.freeze({
    async compile(children: readonly Readonly<{ readonly hash?: string; readonly name?: string }>[]): Promise<void> {
      before?.();
      await after?.({
        stats: {
          hasErrors: () => false,
          toJson: () => ({ children }),
        },
      });
    },
    async completeEnvironment(input: Readonly<{
      readonly distPath: string;
      readonly hasErrors?: boolean;
      readonly hash?: string;
      readonly name: string;
    }>): Promise<void> {
      await afterEnvironment?.({
        environment: { distPath: input.distPath, name: input.name },
        stats: {
          hasErrors: () => input.hasErrors ?? false,
          hash: input.hash,
        },
      });
    },
  });
};

const cohortChildren = (suffix: string): readonly Readonly<{ readonly hash: string; readonly name: string }>[] =>
  rscRuntimeEnvironmentNames.map((name) => ({ hash: `${name}-${suffix}`, name }));

const compilerObserver = (input: Readonly<{
  readonly capture: Array<Readonly<Record<string, unknown>>>;
  readonly enqueued: string[];
  readonly failed: unknown[];
}>) => activateCompilerObserver({
      beginCompletedCohort: () => 'attempt-1',
      capture: async (value) => {
        input.capture.push(value);
        return {
          attemptId: value.attemptId,
          candidateId: 'candidate-1',
          preparedRevision: 'prepared-1',
          rscCohortRevision: 1,
          sourceRevision: value.sourceRevision,
        };
      },
      enqueue: (snapshot) => input.enqueued.push(snapshot.attemptId),
      failAttempt: (_attemptId, error) => input.failed.push(error),
      observeCompileStart: () => undefined,
});

test('resolves the coherent development compiler configuration through Rsbuild', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-compiler-'));
  try {
    const developmentConfig = createRscRuntimeRsbuildConfig({ compilerRoot, mode: 'development' });
    const configuredEnvironments = developmentConfig.environments as Readonly<Record<string, Readonly<{
      readonly tools?: Readonly<{ readonly rspack?: Readonly<{ readonly name?: string }> }>;
    }>>>;
    expect(configuredEnvironments.rsc?.tools?.rspack?.name).toBe('rsc');
    expect(configuredEnvironments.widget?.tools?.rspack?.name).toBe('widget');
    expect(configuredEnvironments.app).toBeUndefined();
    const rsbuild = await createRsbuild({
      config: developmentConfig,
      cwd: process.cwd(),
    });
    const inspection = await rsbuild.inspectConfig({ mode: 'development' });
    const environments = inspection.origin.environmentConfigs;
    const bundlers = inspection.origin.bundlerConfigs;
    const rscBundler = bundlers.find((config) => config.name === 'rsc');
    const widgetBundler = bundlers.find((config) => config.name === 'widget');

    expect(Object.keys(environments).sort()).toEqual(['rsc', 'widget']);
    expect(environments.rsc?.output.target).toBe('node');
    expect(environments.widget?.output.target).toBe('web');
    expect(environments.rsc?.output.distPath.root).toBe(join(compilerRoot, 'rsc'));
    expect(environments.widget?.output.distPath.root).toBe(join(compilerRoot, 'widget'));
    expect(developmentConfig.mode).toBe('production');
    expect(inspection.origin.rsbuildConfig.mode).toBe('production');
    expect(inspection.origin.rsbuildConfig.dev.writeToDisk).toBe(true);
    expect(inspection.origin.rsbuildConfig.server.host).toBe('127.0.0.1');
    expect(inspection.origin.rsbuildConfig.server.port).toBe(0);
    expect(rscBundler?.output?.chunkFilename).toBe('chunks/[name].js');
    expect(rscBundler?.output?.path).toBe(join(compilerRoot, 'rsc'));
    expect(widgetBundler?.output?.path).toBe(join(compilerRoot, 'widget'));
    expect(rscBundler?.module?.rules?.some((rule) =>
      typeof rule === 'object' && rule !== null && 'test' in rule && String(rule.test).includes('request-render'))).toBe(true);
    expect(widgetBundler?.plugins?.some((plugin) => plugin?.constructor?.name.includes('ReactRefresh'))).toBe(false);

    const production = await createRsbuild({
      config: createRscRuntimeRsbuildConfig({ mode: 'production' }),
      cwd: process.cwd(),
    });
    const productionInspection = await production.inspectConfig({ mode: 'production' });
    expect(productionInspection.origin.rsbuildConfig.mode).toBe('production');
    expect(productionInspection.origin.rsbuildConfig.dev.writeToDisk).not.toBe(true);
    expect(productionInspection.origin.environmentConfigs.rsc?.output.distPath.root).toBe('dist/runtime');
    expect(productionInspection.origin.environmentConfigs.widget?.output.distPath.root).toBe('dist/widget');
    expect(productionInspection.origin.environmentConfigs.rsc?.source.entry).not.toHaveProperty('dev/definition');
    expect(productionInspection.origin.environmentConfigs.rsc?.source.entry).not.toHaveProperty('dev/invoke');
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});

test('captures immutable paired compiler outputs and records every digested asset', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    const candidate = await store.begin({ id: 'g1', sourceRevision: 'source-r1' });
    const snapshot = await captureCompilerCohort({
      attemptId: 'attempt-1',
      candidate,
      compilerRoot,
      preparedRuntime,
      rscCohortRevision: 1,
      sourceRevision: 'source-r1',
    });

    await writeFile(join(compilerRoot, 'rsc', 'rsc', 'index.js'), 'overwritten-after-capture', 'utf8');
    expect(await readFile(join(candidate.root, 'rsc', 'rsc', 'index.js'), 'utf8')).toBe('rsc-entry');

    const prepared = await materializeRuntimeGeneration({ snapshot, store });
    const assets = prepared.generation.manifest.assets;
    expect(assets).toEqual(expect.arrayContaining([
      { bytes: 10, path: 'rsc/hook/index.js', sha256: '124bca2527b3be927263a58d4fe32fd7dbaeff7988aa596840a72930d754c19e' },
      { bytes: 9, path: 'rsc/rsc/index.js', sha256: '9d51e6aa438ceebcf519fc709042d53177818b9e41161e477e36686acf169a84' },
      { bytes: 16, path: 'widget/static/js/rsc/index.js', sha256: '293818db721cb0d68e14d84f58fe9bc7ad285be34c4dbee827f967891b94015f' },
    ]));
    expect(assets.map((asset) => asset.path)).toEqual(expect.arrayContaining([
      'rsc/runtime-assets.json',
      'rsc/runtime-definition.json',
      'rsc/agent-runtime.manifest.json',
      'rsc/chunks/101.js',
      'widget/rsc/index.html',
      'widget/static/js/rsc/index.js',
    ]));
    expect(Object.keys(prepared.generation.manifest.metadata).sort())
      .toEqual(['entries', 'stateStoreId']);
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('rejects a removed or replaced paired compiler asset after capture', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    const missingCandidate = await store.begin({ id: 'missing', sourceRevision: 'source-missing' });
    const missingSnapshot = await captureCompilerCohort({
      attemptId: 'attempt-missing', candidate: missingCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-missing',
    });
    await unlink(join(missingCandidate.root, 'widget', 'rsc', 'index.html'));
    await expect(materializeRuntimeGeneration({ snapshot: missingSnapshot, store })).rejects.toThrow('captured cohort');

    const replacedCandidate = await store.begin({ id: 'replaced', sourceRevision: 'source-replaced' });
    const replacedSnapshot = await captureCompilerCohort({
      attemptId: 'attempt-replaced', candidate: replacedCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 2, sourceRevision: 'source-replaced',
    });
    await writeFile(join(replacedCandidate.root, 'widget', 'static', 'js', 'rsc', 'index.js'), 'replaced-client-reference', 'utf8');
    await expect(materializeRuntimeGeneration({ snapshot: replacedSnapshot, store })).rejects.toThrow('captured cohort');

  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('bounds and redacts a definition executable stderr flood', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot, {
      rscFiles: {
        'dev/definition.js': "process.stderr.write('token=supersecret ' + 'x'.repeat(1024 * 1024)); process.exitCode = 1;\n",
      },
    });
    const candidate = await store.begin({ id: 'stderr', sourceRevision: 'source-stderr' });
    const error = await captureCompilerCohort({
      attemptId: 'attempt-stderr', candidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-stderr',
    }).then(
      () => new Error('Definition stderr flood unexpectedly captured.'),
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('stderr');
    expect((error as Error).message).not.toContain('supersecret');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('waits for grace-to-SIGKILL termination of a SIGTERM-ignoring definition child', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const marker = join(storageRoot, 'definition-child.pid');
  const store = createStore(storageRoot);
  let childPid: number | undefined;
  try {
    await writeCompilerCohort(compilerRoot, {
      rscFiles: {
        'dev/definition.js': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);\n`,
      },
    });
    const candidate = await store.begin({ id: 'ignores-term', sourceRevision: 'source-ignores-term' });
    await expect(captureCompilerCohort({
      attemptId: 'attempt-ignores-term', candidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-ignores-term',
    })).rejects.toThrow('exceeded 5 seconds');
    childPid = Number(await readFile(marker, 'utf8'));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(false);
  } finally {
    if (childPid !== undefined && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 10_000);

test('fails compile attempts unless stats contain one nonempty RSC and widget hash', async () => {
  for (const children of [
    [{ name: 'rsc', hash: 'rsc-hash' }],
    [{ name: 'rsc', hash: 'rsc-hash' }, { name: 'rsc', hash: 'second-rsc-hash' }, { name: 'widget', hash: 'widget-hash' }],
    [{ name: 'rsc', hash: 'rsc-hash' }, { name: 'widget' }],
    [{ name: 'rsc', hash: 'rsc-hash' }, { name: 'widget', hash: '' }],
  ]) {
    const capture: Array<Readonly<Record<string, unknown>>> = [];
    const enqueued: string[] = [];
    const failed: unknown[] = [];
    await compilerObserver({ capture, enqueued, failed }).compile(children);
    expect(capture).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(failed).toHaveLength(1);
  }
});

test('passes exact per-environment hashes to capture alongside the rsc and widget source revision', async () => {
  const capture: Array<Readonly<Record<string, unknown>>> = [];
  const enqueued: string[] = [];
  const failed: unknown[] = [];
  const observer = compilerObserver({ capture, enqueued, failed });
  await observer.compile([...cohortChildren('one'), { name: 'ignored-extra', hash: 'ignored' }]);

  expect(failed).toEqual([]);
  expect(enqueued).toEqual(['attempt-1']);
  expect(capture).toHaveLength(1);
  expect(capture[0]).toMatchObject({
    cohortChanged: true,
    environmentHashes: { rsc: 'rsc-one', widget: 'widget-one' },
  });
  expect(capture[0]?.sourceRevision).toBe(sha256(JSON.stringify([['rsc', 'rsc-one'], ['widget', 'widget-one']])));
});

test('stages a checkpoint for every successful environment compilation and skips unusable ones', async () => {
  const staged: Array<Readonly<Record<string, unknown>>> = [];
  const observer = activateCompilerObserver({
    beginCompletedCohort: () => 'attempt-stage',
    capture: async () => undefined,
    enqueue: () => undefined,
    failAttempt: () => undefined,
    observeCompileStart: () => undefined,
    stageEnvironmentCheckpoint: async (input) => { staged.push(input); },
  });

  await observer.completeEnvironment({ distPath: '/compiler/rsc', hash: 'rsc-one', name: 'rsc' });
  await observer.completeEnvironment({ distPath: '/compiler/widget', hash: 'widget-one', name: 'widget' });
  // Failed compilations, unexpected environments, and missing hashes stage
  // nothing; the global after-compile hook is the loud failure path.
  await observer.completeEnvironment({ distPath: '/compiler/rsc', hash: 'rsc-two', hasErrors: true, name: 'rsc' });
  await observer.completeEnvironment({ distPath: '/compiler/other', hash: 'other-one', name: 'other' });
  await observer.completeEnvironment({ distPath: '/compiler/widget', name: 'widget' });

  expect(staged).toEqual([
    { distPath: '/compiler/rsc', environmentName: 'rsc', statsHash: 'rsc-one' },
    { distPath: '/compiler/widget', environmentName: 'widget', statsHash: 'widget-one' },
  ]);
});

test('recaptures an identical cohort from its immutable checkpoints after an enqueue failure', async () => {
  const lifecycle: string[] = [];
  const captures: Array<Readonly<{ readonly cohortChanged: boolean }>> = [];
  const failed: unknown[] = [];
  const snapshots = [
    Object.freeze({ attemptId: 'a', candidateId: 'a', preparedRevision: 'prepared-a', rscCohortRevision: 1, sourceRevision: 'a' }),
    Object.freeze({ attemptId: 'b', candidateId: 'b', preparedRevision: 'prepared-b', rscCohortRevision: 2, sourceRevision: 'b' }),
    Object.freeze({ attemptId: 'b-retry', candidateId: 'b-retry', preparedRevision: 'prepared-b', rscCohortRevision: 3, sourceRevision: 'b' }),
  ] as const satisfies readonly RscRuntimeCompileSnapshot[];
  let index = 0;
  let enqueueCount = 0;
  const observer = activateCompilerObserver({
    beginCompletedCohort: () => `attempt-${String(index)}`,
    capture: async (input) => {
      captures.push({ cohortChanged: input.cohortChanged });
      const snapshot = snapshots[index];
      index += 1;
      return snapshot;
    },
    enqueue: (snapshot) => {
      lifecycle.push(`enqueue-${snapshot.attemptId}`);
      enqueueCount += 1;
      if (enqueueCount === 2) throw new Error('enqueue failed');
    },
    failAttempt: (_attemptId, error) => failed.push(error),
    observeCompileStart: () => undefined,
  });

  await observer.compile(cohortChildren('a'));
  await observer.compile(cohortChildren('b'));
  await observer.compile(cohortChildren('b'));

  expect(lifecycle).toEqual(['enqueue-a', 'enqueue-b', 'enqueue-b-retry']);
  expect(captures).toEqual([
    { cohortChanged: true },
    { cohortChanged: true },
    { cohortChanged: true },
  ]);
  expect(failed).toHaveLength(1);
});

test('requires the lazily loading stdio entry to declare its async cohort assets', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    const manifestPath = join(compilerRoot, 'rsc', 'runtime-assets.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: Record<string, { async?: unknown }> };
    delete manifest.entries['mcp/stdio']?.async;
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const candidate = await store.begin({ id: 'missing-async', sourceRevision: 'source-missing-async' });
    const snapshot = await captureCompilerCohort({
      attemptId: 'attempt-missing-async', candidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-missing-async',
    });
    await expect(materializeRuntimeGeneration({ snapshot, store })).rejects.toThrow('async');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('rejects a genuinely undeclared RSC file outside the known compiler cohort', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot, { rscFiles: { 'undeclared.js': 'not-in-runtime-assets' } });
    const candidate = await store.begin({ id: 'undeclared', sourceRevision: 'source-undeclared' });
    await expect(captureCompilerCohort({
      attemptId: 'attempt-undeclared', candidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-undeclared',
    })).rejects.toThrow('undeclared');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('reconciles a stale known async chunk from a prior incremental compiler cohort', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  const checkpointStore = createCheckpointStore(join(storageRoot, 'environment-checkpoints'));
  try {
    await writeCompilerCohort(compilerRoot);
    const firstCandidate = await store.begin({ id: 'first', sourceRevision: 'source-first' });
    const firstSnapshot = await captureCompilerCohort({
      attemptId: 'attempt-first', candidate: firstCandidate, checkpointStore, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-first',
    });
    const firstPrepared = await materializeRuntimeGeneration({ snapshot: firstSnapshot, store });
    await store.abort(firstPrepared);

    // An incremental compile leaves the previous cohort's chunk on disk; the
    // next staged checkpoint tolerates it because the previous checkpoint of
    // the same environment validated exactly those bytes.
    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    const manifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, manifest.replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    expect(await readFile(join(rscRoot, 'chunks', '101.js'), 'utf8')).toBe('async-chunk');

    const secondCandidate = await store.begin({ id: 'second', sourceRevision: 'source-second' });
    const snapshot = await captureCompilerCohort({
      attemptId: 'attempt-second', candidate: secondCandidate, checkpointStore, compilerRoot, preparedRuntime, rscCohortRevision: 2, sourceRevision: 'source-second',
    });
    const prepared = await materializeRuntimeGeneration({ snapshot, store });

    expect(prepared.generation.manifest.assets.map((asset) => asset.path)).toEqual(expect.arrayContaining([
      'rsc/chunks/202.js',
    ]));
    expect(prepared.generation.manifest.assets.map((asset) => asset.path)).not.toContain('rsc/chunks/101.js');
    expect(await readFile(join(prepared.generation.root, 'rsc', 'chunks', '202.js'), 'utf8')).toBe('replacement-async-chunk');
    await expect(readFile(join(prepared.generation.root, 'rsc', 'chunks', '101.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await checkpointStore.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('recaptures a stale known compiler chunk cohort through the observer after an enqueue failure', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  const checkpointStore = createCheckpointStore(join(storageRoot, 'environment-checkpoints'));
  const snapshots: RscRuntimeCapturedGenerationSnapshot[] = [];
  const failed: unknown[] = [];
  let candidateNumber = 0;
  let enqueueNumber = 0;
  try {
    await writeCompilerCohort(compilerRoot);
    const observer = activateCompilerObserver({
      beginCompletedCohort: () => `attempt-${String(candidateNumber)}`,
      capture: async (input) => {
        candidateNumber += 1;
        const candidate = await store.begin({ id: `candidate-${String(candidateNumber)}`, sourceRevision: input.sourceRevision });
        const cohort = await checkpointStore.acquireCohort(input.environmentHashes);
        let snapshot: RscRuntimeCapturedGenerationSnapshot;
        try {
          snapshot = await captureRuntimeGenerationSnapshot({
            attemptId: input.attemptId,
            candidate,
            cohort: cohort.checkpoints,
            preparedRuntime,
            rscCohortRevision: candidateNumber,
            sourceRevision: input.sourceRevision,
          });
        } finally {
          cohort.release();
        }
        snapshots.push(snapshot);
        return Object.freeze({
          attemptId: snapshot.attemptId,
          candidateId: candidate.id,
          preparedRevision: snapshot.preparedRuntime.sourceRevision,
          rscCohortRevision: snapshot.rscCohortRevision,
          sourceRevision: snapshot.sourceRevision,
        });
      },
      enqueue: () => {
        enqueueNumber += 1;
        if (enqueueNumber === 2) throw new Error('enqueue rejects B');
      },
      failAttempt: (_attemptId, error) => failed.push(error),
      observeCompileStart: () => undefined,
      stageEnvironmentCheckpoint: (input) => checkpointStore.stage({
        environment: input.environmentName,
        hash: input.statsHash,
        sourceRoot: join(compilerRoot, input.environmentName),
      }),
    });
    const stageCohortThroughObserver = async (suffix: string): Promise<void> => {
      for (const environment of rscRuntimeEnvironmentNames) {
        await observer.completeEnvironment({
          distPath: join(compilerRoot, environment),
          hash: `${environment}-${suffix}`,
          name: environment,
        });
      }
    };

    await stageCohortThroughObserver('a');
    await observer.compile(cohortChildren('a'));
    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');

    await stageCohortThroughObserver('b');
    await observer.compile(cohortChildren('b'));
    // The unchanged-hash restage deduplicates and the identical cohort is
    // reassembled from the same immutable checkpoints for the retry.
    await stageCohortThroughObserver('b');
    await observer.compile(cohortChildren('b'));

    expect(failed).toHaveLength(1);
    expect(snapshots).toHaveLength(3);
    for (const snapshot of snapshots.slice(1)) {
      expect(snapshot.assets.map((asset) => asset.path)).toContain('rsc/chunks/202.js');
      expect(snapshot.assets.map((asset) => asset.path)).not.toContain('rsc/chunks/101.js');
    }
  } finally {
    await checkpointStore.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('rejects stale compiler output in a fresh checkpoint store without a validated predecessor', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const otherCompilerRoot = join(storageRoot, 'other-compiler');
  const store = createStore(storageRoot);
  const firstCheckpointStore = createCheckpointStore(join(storageRoot, 'first-checkpoints'));
  const secondCheckpointStore = createCheckpointStore(join(storageRoot, 'second-checkpoints'));
  try {
    await writeCompilerCohort(compilerRoot);
    const firstCandidate = await store.begin({ id: 'first', sourceRevision: 'source-first' });
    await captureCompilerCohort({
      attemptId: 'attempt-first', candidate: firstCandidate, checkpointStore: firstCheckpointStore, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-first',
    });

    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    await firstCheckpointStore.close();

    // The stale-asset tolerance chain lives inside one store's validated
    // staging history; a fresh store treats the leftover chunk as foreign.
    const reusedRootCandidate = await store.begin({ id: 'reused-root', sourceRevision: 'source-reused-root' });
    await expect(captureCompilerCohort({
      attemptId: 'attempt-reused-root', candidate: reusedRootCandidate, checkpointStore: secondCheckpointStore, compilerRoot, preparedRuntime, rscCohortRevision: 2, sourceRevision: 'source-reused-root',
    })).rejects.toThrow('undeclared');

    await writeCompilerCohort(otherCompilerRoot);
    const otherRootManifestPath = join(otherCompilerRoot, 'rsc', 'runtime-assets.json');
    await writeFile(join(otherCompilerRoot, 'rsc', 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    await writeFile(otherRootManifestPath, (await readFile(otherRootManifestPath, 'utf8')).replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    const otherRootCandidate = await store.begin({ id: 'other-root', sourceRevision: 'source-other-root' });
    await expect(captureCompilerCohort({
      attemptId: 'attempt-other-root', candidate: otherRootCandidate, checkpointStore: secondCheckpointStore, compilerRoot: otherCompilerRoot, preparedRuntime, rscCohortRevision: 3, sourceRevision: 'source-other-root',
    })).rejects.toThrow('undeclared');
  } finally {
    await secondCheckpointStore.close().catch(() => undefined);
    await firstCheckpointStore.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('rejects a client entry document that points at a different client-reference asset', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot, {
      widgetFiles: { 'rsc/index.html': '<!doctype html><script src="/static/js/rsc/not-rsc-index.js"></script>' },
    });
    const candidate = await store.begin({ id: 'mismatched-client', sourceRevision: 'source-mismatched-client' });
    const snapshot = await captureCompilerCohort({
      attemptId: 'attempt-mismatched-client', candidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-mismatched-client',
    });
    await expect(materializeRuntimeGeneration({ snapshot, store })).rejects.toThrow('client reference relationship');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});
