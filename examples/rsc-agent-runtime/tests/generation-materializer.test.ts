import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { expect, test } from '@rstest/core';

import {
  createRscRuntimeRsbuildConfig,
} from '../rsbuild.config.js';
import {
  captureRuntimeGenerationSnapshot,
  materializeRuntimeGeneration,
  rscRuntimeGenerationMetadataCodec,
  validateRscRuntimeGenerationMetadata,
  type RscRuntimeGenerationMetadata,
} from '../src/dev/generation-materializer.js';
import { RuntimeGenerationStore } from '../../../packages/agent-bundle/src/dev/runtime-generation-store.ts';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const definitionJson = '{"nativeHooks":[],"resources":[],"tools":[]}';

const runtimeFiles = {
  'chunks/101.js': 'async-chunk',
  'dev/definition.js': `process.stdout.write(${JSON.stringify(`${definitionJson}\n`)});\n`,
  'dev/invoke.js': 'invoke-worker',
  'hook/index.js': 'hook-entry',
  'mcp/http.js': 'http-entry',
  'mcp/stdio.js': 'stdio-entry',
  'rsc/index.js': 'rsc-entry',
} as const;

const widgetFiles = {
  'rsc/index.html': '<!doctype html><script src="/static/js/rsc/index.js"></script>',
  'static/js/rsc/index.js': 'client-reference',
} as const;

const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  await Promise.all(Object.entries(files).map(async ([path, contents]) => {
    const destination = join(root, ...path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, 'utf8');
  }));
};

const writeCompilerCohort = async (
  compilerRoot: string,
  options: Readonly<{
    readonly rscFiles?: Readonly<Record<string, string>>;
    readonly widgetFiles?: Readonly<Record<string, string>>;
  }> = {},
): Promise<void> => {
  const rscRoot = join(compilerRoot, 'rsc');
  await writeTree(rscRoot, { ...runtimeFiles, ...options.rscFiles });
  await writeTree(join(compilerRoot, 'widget'), { ...widgetFiles, ...options.widgetFiles });
  await writeFile(join(rscRoot, 'runtime-assets.json'), JSON.stringify({
    allFiles: Object.keys(runtimeFiles).map((path) => `/${path}`),
    entries: {
      'dev/definition': { initial: { js: ['/dev/definition.js'] } },
      'dev/invoke': { initial: { js: ['/dev/invoke.js'] } },
      'hook/index': { initial: { js: ['/hook/index.js'] } },
      'mcp/http': { async: { js: ['/chunks/101.js'] }, initial: { js: ['/mcp/http.js'] } },
      'mcp/stdio': { async: { js: ['/chunks/101.js'] }, initial: { js: ['/mcp/stdio.js'] } },
      'rsc/index': { async: { js: ['/chunks/101.js'] }, initial: { js: ['/rsc/index.js'] } },
    },
  }), 'utf8');
};

const preparedRuntime = Object.freeze({
  apps: Object.freeze([]),
  provider: './src/dev/provider.ts',
  servers: Object.freeze([]),
  sourceRevision: 'prepared-r1',
});

const createStore = (storageRoot: string): RuntimeGenerationStore<RscRuntimeGenerationMetadata> =>
  new RuntimeGenerationStore({
    metadataCodec: rscRuntimeGenerationMetadataCodec,
    now: () => new Date('2026-08-15T00:00:00.000Z'),
    storageRoot,
    validateMetadata: validateRscRuntimeGenerationMetadata,
  });

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

const compilerObserver = (input: Readonly<{
  readonly capture: Array<Readonly<Record<string, unknown>>>;
  readonly enqueued: string[];
  readonly failed: unknown[];
}>) => {
  const config = createRscRuntimeRsbuildConfig({
    compilerRoot: join(tmpdir(), 'rsc-agent-runtime-observer'),
    mode: 'development',
    onCompile: {
      beforeAttempt: () => 'attempt-1',
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
    },
  });
  const plugin = (config.plugins as readonly unknown[]).find((value): value is Readonly<{
    readonly name: string;
    setup(api: unknown): void;
  }> => typeof value === 'object' && value !== null && 'name' in value && (value as { name?: unknown }).name === 'agent-bundle:rsc-runtime-compile-observer');
  if (plugin === undefined) throw new Error('Compile observer plugin was not configured.');

  let before: (() => void) | undefined;
  let after: ((input: unknown) => Promise<void>) | undefined;
  plugin.setup({
    onAfterDevCompile: (callback: unknown) => { after = callback as (input: unknown) => Promise<void>; },
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
  });
};

test('resolves the coherent development compiler configuration through Rsbuild', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-compiler-'));
  try {
    const rsbuild = await createRsbuild({
      config: createRscRuntimeRsbuildConfig({ compilerRoot, mode: 'development' }),
      cwd: process.cwd(),
    });
    const inspection = await rsbuild.inspectConfig({ mode: 'development' });
    const environments = inspection.origin.environmentConfigs;
    const bundlers = inspection.origin.bundlerConfigs;
    const rscBundler = bundlers.find((config) => config.name === 'rsc');
    const widgetBundler = bundlers.find((config) => config.name === 'widget');
    const appBundler = bundlers.find((config) => config.name === 'app');

    expect(Object.keys(environments).sort()).toEqual(['app', 'rsc', 'widget']);
    expect(environments.rsc?.output.target).toBe('node');
    expect(environments.widget?.output.target).toBe('web');
    expect(environments.rsc?.output.distPath.root).toBe(join(compilerRoot, 'rsc'));
    expect(environments.widget?.output.distPath.root).toBe(join(compilerRoot, 'widget'));
    expect(environments.app?.output.distPath.root).toBe(join(compilerRoot, 'app'));
    expect(inspection.origin.rsbuildConfig.dev.writeToDisk).toBe(true);
    expect(inspection.origin.rsbuildConfig.server.host).toBe('127.0.0.1');
    expect(inspection.origin.rsbuildConfig.server.port).toBe(0);
    expect(rscBundler?.output?.chunkFilename).toBe('chunks/[name].js');
    expect(rscBundler?.output?.path).toBe(join(compilerRoot, 'rsc'));
    expect(widgetBundler?.output?.path).toBe(join(compilerRoot, 'widget'));
    expect(appBundler?.output?.path).toBe(join(compilerRoot, 'app'));
    expect(rscBundler?.module?.rules?.some((rule) =>
      typeof rule === 'object' && rule !== null && 'test' in rule && String(rule.test).includes('request-render'))).toBe(true);
    expect(appBundler?.target).toEqual(expect.arrayContaining(['web']));
    expect(appBundler?.plugins?.some((plugin) => plugin?.constructor?.name.includes('ReactRefresh'))).toBe(true);

    const production = await createRsbuild({
      config: createRscRuntimeRsbuildConfig({ mode: 'production' }),
      cwd: process.cwd(),
    });
    const productionInspection = await production.inspectConfig({ mode: 'production' });
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
    const snapshot = await captureRuntimeGenerationSnapshot({
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
    expect(prepared.generation.manifest.metadata.definitionDigest).toBe(sha256(definitionJson));
    expect(prepared.generation.manifest.metadata.environmentHashes).toEqual(expect.objectContaining({
      rsc: expect.stringMatching(/^[a-f0-9]{64}$/u),
      widget: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
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
    const missingSnapshot = await captureRuntimeGenerationSnapshot({
      attemptId: 'attempt-missing', candidate: missingCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-missing',
    });
    await unlink(join(missingCandidate.root, 'widget', 'rsc', 'index.html'));
    await expect(materializeRuntimeGeneration({ snapshot: missingSnapshot, store })).rejects.toThrow('captured cohort');

    const replacedCandidate = await store.begin({ id: 'replaced', sourceRevision: 'source-replaced' });
    const replacedSnapshot = await captureRuntimeGenerationSnapshot({
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
    const error = await captureRuntimeGenerationSnapshot({
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
    await expect(captureRuntimeGenerationSnapshot({
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

test('requires every executable entry to declare its async cohort assets', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    const manifestPath = join(compilerRoot, 'rsc', 'runtime-assets.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: Record<string, { async?: unknown }> };
    delete manifest.entries['mcp/http']?.async;
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const candidate = await store.begin({ id: 'missing-async', sourceRevision: 'source-missing-async' });
    const snapshot = await captureRuntimeGenerationSnapshot({
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
    await expect(captureRuntimeGenerationSnapshot({
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
  try {
    await writeCompilerCohort(compilerRoot);
    const firstCandidate = await store.begin({ id: 'first', sourceRevision: 'source-first' });
    const firstSnapshot = await captureRuntimeGenerationSnapshot({
      attemptId: 'attempt-first', candidate: firstCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-first',
    });
    const firstPrepared = await materializeRuntimeGeneration({ snapshot: firstSnapshot, store });
    await store.abort(firstPrepared);

    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    const manifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, manifest.replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    expect(await readFile(join(rscRoot, 'chunks', '101.js'), 'utf8')).toBe('async-chunk');

    const secondCandidate = await store.begin({ id: 'second', sourceRevision: 'source-second' });
    const snapshot = await captureRuntimeGenerationSnapshot({
      attemptId: 'attempt-second', candidate: secondCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 2, sourceRevision: 'source-second',
    });
    const prepared = await materializeRuntimeGeneration({ snapshot, store });

    expect(prepared.generation.manifest.assets.map((asset) => asset.path)).toEqual(expect.arrayContaining([
      'rsc/chunks/202.js',
    ]));
    expect(prepared.generation.manifest.assets.map((asset) => asset.path)).not.toContain('rsc/chunks/101.js');
    expect(await readFile(join(prepared.generation.root, 'rsc', 'chunks', '202.js'), 'utf8')).toBe('replacement-async-chunk');
    await expect(readFile(join(prepared.generation.root, 'rsc', 'chunks', '101.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
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
    const snapshot = await captureRuntimeGenerationSnapshot({
      attemptId: 'attempt-mismatched-client', candidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-mismatched-client',
    });
    await expect(materializeRuntimeGeneration({ snapshot, store })).rejects.toThrow('client reference relationship');
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});
