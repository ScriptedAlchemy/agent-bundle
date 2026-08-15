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

const writeCompilerCohort = async (compilerRoot: string): Promise<void> => {
  const rscRoot = join(compilerRoot, 'rsc');
  await writeTree(rscRoot, runtimeFiles);
  await writeTree(join(compilerRoot, 'widget'), widgetFiles);
  await writeFile(join(rscRoot, 'runtime-assets.json'), JSON.stringify({
    allFiles: Object.keys(runtimeFiles).map((path) => `/${path}`),
    entries: {
      'dev/definition': { initial: { js: ['/dev/definition.js'] } },
      'dev/invoke': { initial: { js: ['/dev/invoke.js'] } },
      'hook/index': { initial: { js: ['/hook/index.js'] } },
      'mcp/http': { initial: { js: ['/mcp/http.js'] } },
      'mcp/stdio': { initial: { js: ['/mcp/stdio.js'] } },
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
