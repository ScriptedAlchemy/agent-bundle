import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { expect, test } from '@rstest/core';

import {
  createRscRuntimeRsbuildConfig,
  type RscRuntimeCompileSnapshot,
} from '../rsbuild.config.js';
import {
  captureRuntimeGenerationSnapshot,
  createRscCompilerAssetCheckpointTracker,
  materializeRuntimeGeneration,
  rscRuntimeGenerationMetadataCodec,
  runtimeDefinitionDigest,
  validateRscRuntimeGenerationMetadata,
  type RscCompilerAssetCheckpointTracker,
  type RscRuntimeCapturedGenerationSnapshot,
  type RscRuntimeGenerationMetadata,
} from '../src/dev/generation-materializer.js';
import { digest, stableJson } from '../../../packages/agent-bundle/src/core/digest.ts';
import { RuntimeGenerationStore } from '../../../packages/agent-bundle/src/dev/runtime-generation-store.ts';
import type { DevRuntimePreparedProject } from '../../../packages/agent-bundle/src/dev/runtime-provider.ts';

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

const preparedRuntimeWithApp = (
  app: Partial<DevRuntimePreparedProject['apps'][number]> = {},
  runtime: Partial<Omit<DevRuntimePreparedProject, 'apps'>> = {},
): DevRuntimePreparedProject => Object.freeze({
  apps: Object.freeze([Object.freeze({
    _meta: Object.freeze({ presentation: Object.freeze({ accent: 'indigo', version: 1 }) }),
    id: 'timeline-app',
    name: 'Timeline',
    resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
    serverId: 'timeline-server',
    serverName: 'Timeline MCP',
    source: '/workspace/plugin/agent-bundle.config.ts',
    targets: Object.freeze(['claude', 'codex']),
    template: '/workspace/plugin/src/app/edit-timeline.html',
    ...app,
  })]),
  provider: './src/dev/provider.ts',
  servers: Object.freeze([Object.freeze({
    command: 'node',
    cwd: '/workspace/plugin',
    id: 'timeline-server',
    name: 'Timeline MCP',
    source: '/workspace/plugin/agent-bundle.config.ts',
    targets: Object.freeze(['claude', 'codex']),
    transport: 'stdio' as const,
  })]),
  sourceRevision: 'prepared-r1',
  ...runtime,
});

const createStore = (storageRoot: string): RuntimeGenerationStore<RscRuntimeGenerationMetadata> =>
  new RuntimeGenerationStore({
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

const acceptCompilerAssetCheckpoint = (snapshot: RscRuntimeCapturedGenerationSnapshot): void => {
  expect(snapshot.acceptCompilerAssetCheckpoint).toBeTypeOf('function');
  snapshot.acceptCompilerAssetCheckpoint?.();
};

const captureWithCompilerAssetCheckpoint = async (
  input: Parameters<typeof captureRuntimeGenerationSnapshot>[0],
  tracker: RscCompilerAssetCheckpointTracker,
) => captureRuntimeGenerationSnapshot({
  ...input,
  compilerAssetCheckpointTracker: tracker,
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

const activateCompilerObserver = (onCompile: NonNullable<Parameters<typeof createRscRuntimeRsbuildConfig>[0]['onCompile']>) => {
  const config = createRscRuntimeRsbuildConfig({
    compilerRoot: join(tmpdir(), 'rsc-agent-runtime-observer'),
    mode: 'development',
    onCompile,
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

const compilerObserver = (input: Readonly<{
  readonly capture: Array<Readonly<Record<string, unknown>>>;
  readonly enqueued: string[];
  readonly failed: unknown[];
}>) => activateCompilerObserver({
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
    expect(prepared.generation.manifest.metadata.definitionDigest)
      .toBe(sha256('{"apps":[],"definition":{"nativeHooks":[],"resources":[],"tools":[]}}'));
    expect(prepared.generation.manifest.metadata.environmentHashes).toEqual(expect.objectContaining({
      rsc: expect.stringMatching(/^[a-f0-9]{64}$/u),
      widget: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('includes prepared App definitions in the captured runtime definition digest', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-definition-digest-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    const metadataFor = async (
      id: string,
      prepared: DevRuntimePreparedProject,
      sourceRevision = 'captured-r1',
    ) => {
      const candidate = await store.begin({ id, sourceRevision });
      const snapshot = await captureRuntimeGenerationSnapshot({
        attemptId: `attempt-${id}`,
        candidate,
        compilerRoot,
        preparedRuntime: prepared,
        rscCohortRevision: 1,
        sourceRevision,
      });
      const generation = await materializeRuntimeGeneration({ snapshot, store });
      return Object.freeze({ generation: generation.generation, metadata: generation.generation.manifest.metadata, snapshot });
    };

    const baseline = await metadataFor('baseline', preparedRuntimeWithApp());
    const appDefinitionVariants: readonly Readonly<{ readonly id: string; readonly prepared: DevRuntimePreparedProject }>[] = [
      { id: 'meta', prepared: preparedRuntimeWithApp({ _meta: Object.freeze({ presentation: Object.freeze({ accent: 'teal', version: 2 }) }) }) },
      { id: 'id', prepared: preparedRuntimeWithApp({ id: 'timeline-app-v2' }) },
      { id: 'name', prepared: preparedRuntimeWithApp({ name: 'Timeline v2' }) },
      { id: 'server-id', prepared: preparedRuntimeWithApp({ serverId: 'timeline-server-v2' }) },
      { id: 'server-name', prepared: preparedRuntimeWithApp({ serverName: 'Timeline MCP v2' }) },
      { id: 'resource-uri', prepared: preparedRuntimeWithApp({ resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v2.html' }) },
      { id: 'targets', prepared: preparedRuntimeWithApp({ targets: Object.freeze(['codex']) }) },
    ];

    for (const variant of appDefinitionVariants) {
      const captured = await metadataFor(variant.id, variant.prepared);
      expect(captured.metadata.definitionDigest).not.toBe(baseline.metadata.definitionDigest);
      expect(captured.metadata.servers.map((server) => server.definitionDigest)).toEqual([
        captured.metadata.definitionDigest,
        captured.metadata.definitionDigest,
      ]);
    }

    const sourceAndTransportNoise = await metadataFor('noise', preparedRuntimeWithApp({
      source: '/other-machine/plugin/agent-bundle.config.ts',
      template: '/other-machine/plugin/src/app/edit-timeline.html',
    }, {
      provider: '/other-machine/plugin/src/dev/provider.ts',
      servers: Object.freeze([Object.freeze({
        args: Object.freeze(['--serve', '--token=top-secret']),
        command: '/other-machine/bin/timeline-server',
        cwd: '/other-machine/plugin',
        env: Object.freeze({ API_TOKEN: 'top-secret' }),
        headers: Object.freeze({ Authorization: 'Bearer top-secret' }),
        id: 'timeline-server',
        name: 'Timeline MCP',
        source: '/other-machine/plugin/agent-bundle.config.ts',
        targets: Object.freeze(['claude', 'codex']),
        transport: 'streamable-http' as const,
        url: 'https://other-machine.invalid/mcp',
      })]),
      sourceRevision: 'prepared-r2',
    }), 'captured-r2');
    expect(sourceAndTransportNoise.metadata.definitionDigest).toBe(baseline.metadata.definitionDigest);

    expect(runtimeDefinitionDigest(baseline.snapshot.definition, baseline.snapshot.preparedRuntime))
      .toBe(baseline.metadata.definitionDigest);

    const [timelineApp] = baseline.snapshot.preparedRuntime.apps;
    if (timelineApp === undefined) throw new Error('Baseline prepared App was not captured.');
    const activityApp = Object.freeze({
      ...timelineApp,
      id: 'activity-app',
      name: 'Activity',
      resourceUri: 'ui://rsc-agent-runtime/activity-v1.html',
    });
    const orderedForward = await metadataFor('ordered-forward', Object.freeze({
      ...baseline.snapshot.preparedRuntime,
      apps: Object.freeze([timelineApp, activityApp]),
    }));
    const orderedReverse = await metadataFor('ordered-reverse', Object.freeze({
      ...baseline.snapshot.preparedRuntime,
      apps: Object.freeze([activityApp, timelineApp]),
    }));
    expect(orderedReverse.metadata.definitionDigest).toBe(orderedForward.metadata.definitionDigest);
    expect(orderedForward.metadata.appDefinitions.map((app) => app.id)).toEqual(['activity-app', 'timeline-app']);
    expect(orderedForward.metadata.appDefinitions.every((app) => !('template' in app))).toBe(true);
    const [firstAppDefinition] = orderedForward.metadata.appDefinitions;
    if (firstAppDefinition === undefined || firstAppDefinition._meta === undefined) throw new Error('Ordered App definition was malformed.');
    expect(Object.isFrozen(orderedForward.metadata.appDefinitions)).toBe(true);
    expect(Object.isFrozen(firstAppDefinition)).toBe(true);
    expect(Object.isFrozen(firstAppDefinition.targets)).toBe(true);
    expect(Object.isFrozen(firstAppDefinition._meta)).toBe(true);
    expect(Object.isFrozen(firstAppDefinition._meta.presentation)).toBe(true);
  } finally {
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('rejects a rewritten prepared App definition manifest on post-rename reload', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-persisted-app-definition-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  try {
    await writeCompilerCohort(compilerRoot);
    const candidate = await store.begin({ id: 'persisted-app', sourceRevision: 'source-persisted-app' });
    const snapshot = await captureRuntimeGenerationSnapshot({
      attemptId: 'attempt-persisted-app',
      candidate,
      compilerRoot,
      preparedRuntime: preparedRuntimeWithApp(),
      rscCohortRevision: 1,
      sourceRevision: 'source-persisted-app',
    });
    let waits = 0;
    await expect(materializeRuntimeGeneration({
      guard: {
        check: () => true,
        wait: async () => {
          waits += 1;
          if (waits !== 1) return;
          await rewriteGenerationManifest(snapshot.candidate.root, (metadata) => ({
            ...metadata,
            appDefinitions: [{
              ...(metadata.appDefinitions as readonly Readonly<Record<string, unknown>>[])[0],
              name: 'Tampered timeline',
            }],
          }));
        },
      },
      snapshot,
      store,
    })).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });
    expect(waits).toBe(1);
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

test('accepts a compiler checkpoint only after enqueue and discards it after an enqueue failure', async () => {
  const lifecycle: string[] = [];
  const captures: Array<Readonly<{ readonly cohortChanged: boolean }>> = [];
  const failed: unknown[] = [];
  const snapshots = [
    Object.freeze({
      acceptCompilerAssetCheckpoint: () => lifecycle.push('accept-a'),
      attemptId: 'a', candidateId: 'a', discardCompilerAssetCheckpoint: () => lifecycle.push('discard-a'), preparedRevision: 'prepared-a', rscCohortRevision: 1, sourceRevision: 'a',
    }),
    Object.freeze({
      acceptCompilerAssetCheckpoint: () => lifecycle.push('accept-b'),
      attemptId: 'b', candidateId: 'b', discardCompilerAssetCheckpoint: () => lifecycle.push('discard-b'), preparedRevision: 'prepared-b', rscCohortRevision: 2, sourceRevision: 'b',
    }),
    Object.freeze({
      acceptCompilerAssetCheckpoint: () => lifecycle.push('accept-b-retry'),
      attemptId: 'b-retry', candidateId: 'b-retry', discardCompilerAssetCheckpoint: () => lifecycle.push('discard-b-retry'), preparedRevision: 'prepared-b', rscCohortRevision: 3, sourceRevision: 'b',
    }),
  ] as const satisfies readonly RscRuntimeCompileSnapshot[];
  let index = 0;
  let enqueueCount = 0;
  const observer = activateCompilerObserver({
    beforeAttempt: () => `attempt-${String(index)}`,
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
  });

  await observer.compile([{ name: 'rsc', hash: 'rsc-a' }, { name: 'widget', hash: 'widget-a' }]);
  await observer.compile([{ name: 'rsc', hash: 'rsc-b' }, { name: 'widget', hash: 'widget-b' }]);
  await observer.compile([{ name: 'rsc', hash: 'rsc-b' }, { name: 'widget', hash: 'widget-b' }]);

  expect(lifecycle).toEqual([
    'enqueue-a', 'accept-a',
    'enqueue-b', 'discard-b',
    'enqueue-b-retry', 'accept-b-retry',
  ]);
  expect(captures).toEqual([
    { cohortChanged: true },
    { cohortChanged: true },
    { cohortChanged: true },
  ]);
  expect(failed).toHaveLength(1);
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
  const tracker = createRscCompilerAssetCheckpointTracker();
  try {
    await writeCompilerCohort(compilerRoot);
    const firstCandidate = await store.begin({ id: 'first', sourceRevision: 'source-first' });
    const firstSnapshot = await captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-first', candidate: firstCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-first',
    }, tracker);
    const firstPrepared = await materializeRuntimeGeneration({ snapshot: firstSnapshot, store });
    await store.abort(firstPrepared);
    acceptCompilerAssetCheckpoint(firstSnapshot);

    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    const manifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, manifest.replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    expect(await readFile(join(rscRoot, 'chunks', '101.js'), 'utf8')).toBe('async-chunk');

    const secondCandidate = await store.begin({ id: 'second', sourceRevision: 'source-second' });
    const snapshot = await captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-second', candidate: secondCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 2, sourceRevision: 'source-second',
    }, tracker);
    const prepared = await materializeRuntimeGeneration({ snapshot, store });

    expect(prepared.generation.manifest.assets.map((asset) => asset.path)).toEqual(expect.arrayContaining([
      'rsc/chunks/202.js',
    ]));
    expect(prepared.generation.manifest.assets.map((asset) => asset.path)).not.toContain('rsc/chunks/101.js');
    expect(await readFile(join(prepared.generation.root, 'rsc', 'chunks', '202.js'), 'utf8')).toBe('replacement-async-chunk');
    await expect(readFile(join(prepared.generation.root, 'rsc', 'chunks', '101.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    tracker.close();
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('retries a stale known compiler chunk after enqueue discards the prior capture checkpoint', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  const tracker = createRscCompilerAssetCheckpointTracker();
  const snapshots: RscRuntimeCapturedGenerationSnapshot[] = [];
  const failed: unknown[] = [];
  let candidateNumber = 0;
  let enqueueNumber = 0;
  try {
    await writeCompilerCohort(compilerRoot);
    const observer = activateCompilerObserver({
      beforeAttempt: () => `attempt-${String(candidateNumber)}`,
      capture: async (input) => {
        candidateNumber += 1;
        const candidate = await store.begin({ id: `candidate-${String(candidateNumber)}`, sourceRevision: input.sourceRevision });
        const snapshot = await captureWithCompilerAssetCheckpoint({
          attemptId: input.attemptId,
          candidate,
          compilerRoot,
          preparedRuntime,
          rscCohortRevision: candidateNumber,
          sourceRevision: input.sourceRevision,
        }, tracker);
        snapshots.push(snapshot);
        return Object.freeze({
          ...snapshot,
          candidateId: candidate.id,
          preparedRevision: snapshot.preparedRuntime.sourceRevision,
        });
      },
      enqueue: () => {
        enqueueNumber += 1;
        if (enqueueNumber === 2) throw new Error('enqueue rejects B');
      },
      failAttempt: (_attemptId, error) => failed.push(error),
    });

    await observer.compile([{ name: 'rsc', hash: 'rsc-a' }, { name: 'widget', hash: 'widget-a' }]);
    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');

    await observer.compile([{ name: 'rsc', hash: 'rsc-b' }, { name: 'widget', hash: 'widget-b' }]);
    await observer.compile([{ name: 'rsc', hash: 'rsc-b' }, { name: 'widget', hash: 'widget-b' }]);

    expect(failed).toHaveLength(1);
    expect(snapshots).toHaveLength(3);
    for (const snapshot of snapshots.slice(1)) {
      expect(snapshot.assets.map((asset) => asset.path)).toContain('rsc/chunks/202.js');
      expect(snapshot.assets.map((asset) => asset.path)).not.toContain('rsc/chunks/101.js');
    }
  } finally {
    tracker.close();
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('isolates roots between tracker sessions and revokes checkpoint provenance on close', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const otherCompilerRoot = join(storageRoot, 'other-compiler');
  const store = createStore(storageRoot);
  const firstTracker = createRscCompilerAssetCheckpointTracker();
  let secondTracker: RscCompilerAssetCheckpointTracker | undefined;
  try {
    await writeCompilerCohort(compilerRoot);
    const firstCandidate = await store.begin({ id: 'first', sourceRevision: 'source-first' });
    const firstSnapshot = await captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-first', candidate: firstCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-first',
    }, firstTracker);
    acceptCompilerAssetCheckpoint(firstSnapshot);

    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    firstTracker.close();

    secondTracker = createRscCompilerAssetCheckpointTracker();
    const reusedRootCandidate = await store.begin({ id: 'reused-root', sourceRevision: 'source-reused-root' });
    await expect(captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-reused-root', candidate: reusedRootCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 2, sourceRevision: 'source-reused-root',
    }, secondTracker as RscCompilerAssetCheckpointTracker)).rejects.toThrow('undeclared');

    await writeCompilerCohort(otherCompilerRoot);
    const otherRootManifestPath = join(otherCompilerRoot, 'rsc', 'runtime-assets.json');
    await writeFile(join(otherCompilerRoot, 'rsc', 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    await writeFile(otherRootManifestPath, (await readFile(otherRootManifestPath, 'utf8')).replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    const otherRootCandidate = await store.begin({ id: 'other-root', sourceRevision: 'source-other-root' });
    await expect(captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-other-root', candidate: otherRootCandidate, compilerRoot: otherCompilerRoot, preparedRuntime, rscCohortRevision: 3, sourceRevision: 'source-other-root',
    }, secondTracker as RscCompilerAssetCheckpointTracker)).rejects.toThrow('undeclared');
  } finally {
    secondTracker?.close();
    firstTracker.close();
    await store.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test('serializes concurrent same-root captures and commits checkpoints in capture order', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-generations-'));
  const compilerRoot = join(storageRoot, 'compiler');
  const store = createStore(storageRoot);
  const tracker = createRscCompilerAssetCheckpointTracker();
  try {
    await writeCompilerCohort(compilerRoot);
    const firstCandidate = await store.begin({ id: 'first', sourceRevision: 'source-first' });
    const firstSnapshot = await captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-first', candidate: firstCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 1, sourceRevision: 'source-first',
    }, tracker);
    acceptCompilerAssetCheckpoint(firstSnapshot);

    const rscRoot = join(compilerRoot, 'rsc');
    await writeFile(join(rscRoot, 'chunks', '202.js'), 'replacement-async-chunk', 'utf8');
    const manifestPath = join(rscRoot, 'runtime-assets.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replaceAll('/chunks/101.js', '/chunks/202.js'), 'utf8');
    const secondCandidate = await store.begin({ id: 'second', sourceRevision: 'source-second' });
    const thirdCandidate = await store.begin({ id: 'third', sourceRevision: 'source-third' });
    const secondSnapshot = await captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-second', candidate: secondCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 2, sourceRevision: 'source-second',
    }, tracker);
    let thirdSettled = false;
    const thirdSnapshotPromise = captureWithCompilerAssetCheckpoint({
      attemptId: 'attempt-third', candidate: thirdCandidate, compilerRoot, preparedRuntime, rscCohortRevision: 3, sourceRevision: 'source-third',
    }, tracker).then((snapshot) => {
      thirdSettled = true;
      return snapshot;
    });
    await new Promise<void>((resolveMicrotask) => queueMicrotask(resolveMicrotask));
    expect(thirdSettled).toBe(false);

    acceptCompilerAssetCheckpoint(secondSnapshot);
    const thirdSnapshot = await thirdSnapshotPromise;
    expect(thirdSnapshot.assets.map((asset) => asset.path)).toContain('rsc/chunks/202.js');
    expect(thirdSnapshot.assets.map((asset) => asset.path)).not.toContain('rsc/chunks/101.js');
    acceptCompilerAssetCheckpoint(thirdSnapshot);
  } finally {
    tracker.close();
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
