import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { expect, test } from '@rstest/core';
import { createRsbuild, type StartDevServerResult } from '@rsbuild/core';

import {
  ArtifactService,
  ProjectService,
} from '../../../packages/agent-bundle/src/dev/index.ts';
import { EpochStore } from '../../../packages/agent-bundle/src/dev/epoch-store.ts';
import { resolveDevRuntimeProvider } from '../../../packages/agent-bundle/src/dev/runtime-provider-loader.ts';
import {
  createRscRuntimeRsbuildConfig,
  type RscRuntimeActivationOutcome,
  type RscRuntimeCompileSnapshot,
} from '../rsbuild.config.js';
import { createDevRuntimeProvider } from '../src/dev/provider.js';
import { ResourceLedger, RsbuildRuntimeSession } from '../src/dev/rsbuild-runtime-session.js';
import { copyExample, type CopiedExample } from './support/copy-example.ts';
import { ensureExampleBuilt } from './support/ensure-built.ts';
import { timeScale } from './support/time-scale.ts';

const exampleRoot = process.cwd();

// Budgets stay unscaled at the call sites and are scaled here, so a contended
// host widens every deadline instead of only the ones a caller remembered to
// multiply (see tests/support/time-scale.ts).
const waitForWithin = async (predicate: () => boolean, budgetMs: number): Promise<void> => {
  const deadline = Date.now() + budgetMs * timeScale;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the RSC runtime provider.');
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
};

const waitFor = async (predicate: () => boolean): Promise<void> => waitForWithin(predicate, 15_000);

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
};

type CompileObserverContract = NonNullable<Parameters<typeof createRscRuntimeRsbuildConfig>[0]['onCompile']>;

const compileObserver = (
  onCompile: Omit<CompileObserverContract, 'stageEnvironmentCheckpoint'> & Partial<Pick<CompileObserverContract, 'stageEnvironmentCheckpoint'>>,
) => {
  const config = createRscRuntimeRsbuildConfig({
    compilerRoot: join(tmpdir(), 'rsc-provider-observer'),
    mode: 'development',
    onCompile: { stageEnvironmentCheckpoint: async () => undefined, ...onCompile },
  });
  const plugin = (config.plugins as readonly unknown[]).find((candidate): candidate is Readonly<{
    readonly name: string;
    setup(api: unknown): void;
  }> => typeof candidate === 'object' && candidate !== null &&
    (candidate as { readonly name?: unknown }).name === 'agent-bundle:rsc-runtime-compile-observer');
  if (plugin === undefined) throw new Error('RSC compiler observer plugin is unavailable.');
  let before: (() => void) | undefined;
  let after: ((input: unknown) => Promise<void>) | undefined;
  plugin.setup({
    onAfterDevCompile: (callback: unknown) => { after = callback as (input: unknown) => Promise<void>; },
    onAfterEnvironmentCompile: () => undefined,
    onBeforeDevCompile: (callback: unknown) => { before = callback as () => void; },
  });
  const observeCompileStart = (): void => {
    if (before === undefined) throw new Error('RSC compiler observer before hook is unavailable.');
    before();
  };
  const completeAttempt = async (input: Readonly<{
    readonly children?: readonly unknown[];
    readonly hasErrors?: boolean;
  }> = {}): Promise<void> => {
    if (after === undefined) throw new Error('RSC compiler observer after hook is unavailable.');
    await after({
      stats: {
        hasErrors: () => input.hasErrors ?? false,
        toJson: () => ({
          children: input.children ?? [
            { hash: 'rsc-hash', name: 'rsc' },
            { hash: 'widget-hash', name: 'widget' },
            { hash: 'app-hash', name: 'app' },
          ],
        }),
      },
    });
  };
  return Object.freeze({
    async compile(input: Readonly<{
      readonly children?: readonly unknown[];
      readonly hasErrors?: boolean;
    }> = {}): Promise<void> {
      observeCompileStart();
      await completeAttempt(input);
    },
    completeAttempt,
    observeCompileStart,
  });
};

/**
 * Wraps the real Rsbuild factory to steal the compile-observer plugin's dev
 * hooks. Registering the plugin against a second minimal API shares its
 * closure state (captured cohort) with the real compiler, so a test can
 * drive additional compile lifecycles deterministically while the real
 * watcher is idle.
 */
const interceptCompileObserver = () => {
  let before: (() => void) | undefined;
  let after: ((input: unknown) => Promise<void>) | undefined;
  let afterEnvironment: ((input: unknown) => Promise<void>) | undefined;
  const create = (async (input: Parameters<typeof createRsbuild>[0]) => {
    const plugins = (input?.config as Readonly<{ readonly plugins?: readonly unknown[] }> | undefined)?.plugins ?? [];
    const plugin = plugins.find((candidate): candidate is Readonly<{
      readonly name: string;
      setup(api: unknown): void;
    }> => typeof candidate === 'object' && candidate !== null &&
      (candidate as { readonly name?: unknown }).name === 'agent-bundle:rsc-runtime-compile-observer');
    if (plugin === undefined) throw new Error('RSC compile observer plugin is unavailable.');
    plugin.setup({
      onAfterDevCompile: (callback: unknown) => { after = callback as (input: unknown) => Promise<void>; },
      onAfterEnvironmentCompile: (callback: unknown) => { afterEnvironment = callback as (input: unknown) => Promise<void>; },
      onBeforeDevCompile: (callback: unknown) => { before = callback as () => void; },
    });
    return createRsbuild(input);
  }) as typeof createRsbuild;
  return Object.freeze({
    async completeAttempt(input: Readonly<{
      readonly children?: readonly Readonly<{ readonly hash: string; readonly name: string }>[];
      readonly hasErrors?: boolean;
    }> = {}): Promise<void> {
      if (after === undefined) throw new Error('RSC compile observer hooks are unavailable.');
      await after({
        stats: {
          hasErrors: () => input.hasErrors ?? false,
          toJson: () => ({ children: input.children ?? [] }),
        },
      });
    },
    create,
    observeCompileStart: (): void => {
      if (before === undefined) throw new Error('RSC compile observer hooks are unavailable.');
      before();
    },
    /**
     * Drives the plugin's per-environment staging hook against the session's
     * real compiler output roots, staging an immutable checkpoint under a
     * test-chosen hash so a synthetic attempt can assemble a real cohort.
     */
    async stageEnvironment(input: Readonly<{
      readonly distPath: string;
      readonly hash: string;
      readonly name: string;
    }>): Promise<void> {
      if (afterEnvironment === undefined) throw new Error('RSC compile observer hooks are unavailable.');
      await afterEnvironment({
        environment: { distPath: input.distPath, name: input.name },
        stats: { hasErrors: () => false, hash: input.hash },
      });
    },
  });
};

const stageSyntheticCohort = async (
  observer: ReturnType<typeof interceptCompileObserver>,
  storageRoot: string,
  suffix: string,
): Promise<readonly Readonly<{ readonly hash: string; readonly name: string }>[]> => {
  const children: Array<Readonly<{ readonly hash: string; readonly name: string }>> = [];
  for (const name of ['rsc', 'widget', 'app'] as const) {
    const hash = `${name}-${suffix}`;
    await observer.stageEnvironment({ distPath: join(storageRoot, 'compiler', name), hash, name });
    children.push({ hash, name });
  }
  return children;
};

const snapshotFor = (attemptId: string, sourceRevision: string): RscRuntimeCompileSnapshot => Object.freeze({
  attemptId,
  candidateId: attemptId,
  preparedRevision: 'prepared',
  rscCohortRevision: 1,
  sourceRevision,
});

const startContext = (input: Readonly<{
  readonly projectRoot: string;
  readonly preparedRuntime: NonNullable<Awaited<ReturnType<ProjectService['prepare']>>['devRuntime']>;
  readonly providerSessionId: string;
  readonly signal: AbortSignal;
  readonly storageRoot: string;
}>) => Object.freeze({
  artifactStatus: () => Object.freeze({ state: 'missing' as const }),
  emit: () => undefined,
  environment: Object.freeze({}),
  projectRoot: input.projectRoot,
  preparedRuntime: input.preparedRuntime,
  providerSessionId: input.providerSessionId,
  signal: input.signal,
  storageRoot: input.storageRoot,
});

const copyProviderExample = async (): Promise<CopiedExample> =>
  copyExample(exampleRoot, { linkPackages: true, prefix: 'rsc-agent-runtime-provider-' });

/**
 * Replaces source atomically through a rename staged OUTSIDE the watched
 * project. An in-place write is truncate-then-append, which a loaded watcher
 * observes as two change events and compiles twice; a temp file created
 * inside the watched directory is just as bad, because the watcher also sees
 * the temp file's creation as a directory change. Either duplicate compile
 * supersedes the generation that ordinal-pinned assertions expect to commit.
 * The temp file lives in the project's parent (the copied workspace root,
 * same filesystem, never watched) so the rename into place is the only event.
 */
const replaceSource = async (projectRoot: string, path: string, replace: (source: string) => string): Promise<void> => {
  const source = await readFile(path, 'utf8');
  const temporary = join(projectRoot, '..', `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, replace(source));
  await rename(temporary, path);
};

const changeDefinition = async (projectRoot: string, replacement: string): Promise<void> => {
  await replaceSource(
    projectRoot,
    join(projectRoot, 'src', 'definition.ts'),
    (source) => source.replace('Read the current shared runtime state.', replacement),
  );
};

const changeWorkerImplementation = async (projectRoot: string, marker: string): Promise<void> => {
  await replaceSource(
    projectRoot,
    join(projectRoot, 'src', 'rsc', 'worker.tsx'),
    (source) => source.replace(
      /RSC worker received an invalid event(?: [^']*)?/u,
      `RSC worker received an invalid event ${marker}`,
    ),
  );
};

const introduceWorkerSyntaxError = async (projectRoot: string): Promise<void> => {
  await replaceSource(
    projectRoot,
    join(projectRoot, 'src', 'rsc', 'worker.tsx'),
    (source) => `${source}\nconst = ;\n`,
  );
};

test('requires the App environment through the public Rsbuild compiler hook', async () => {
  const config = createRscRuntimeRsbuildConfig({
    compilerRoot: join(tmpdir(), 'rsc-provider-app-environment'),
    mode: 'development',
    onAppReload: () => undefined,
  });
  const plugin = (config.plugins as readonly unknown[]).find((candidate): candidate is Readonly<{
    readonly name: string;
    setup(api: unknown): void;
  }> => typeof candidate === 'object' && candidate !== null &&
    (candidate as { readonly name?: unknown }).name === 'agent-bundle:rsc-runtime-app-reload');
  if (plugin === undefined) throw new Error('RSC App reload plugin is unavailable.');
  let afterCreate: ((input: unknown) => void) | undefined;
  plugin.setup({
    onAfterCreateCompiler: (callback: unknown) => { afterCreate = callback as (input: unknown) => void; },
    onAfterEnvironmentCompile: () => undefined,
    onBeforeStartDevServer: () => undefined,
    onCloseDevServer: () => undefined,
  });
  expect(() => afterCreate?.({ environments: {} })).toThrow('App environment');
  expect(() => afterCreate?.({ environments: { app: {} } })).not.toThrow();
});

test('emits one owned App reload for each later successful changed App compilation', async () => {
  const reloads: number[] = [];
  const config = createRscRuntimeRsbuildConfig({
    compilerRoot: join(tmpdir(), 'rsc-provider-app-reload'),
    mode: 'development',
    onAppReload: () => { reloads.push(reloads.length + 1); },
  });
  const plugin = (config.plugins as readonly unknown[]).find((candidate): candidate is Readonly<{
    readonly name: string;
    setup(api: unknown): void;
  }> => typeof candidate === 'object' && candidate !== null &&
    (candidate as { readonly name?: unknown }).name === 'agent-bundle:rsc-runtime-app-reload');
  if (plugin === undefined) throw new Error('RSC App reload plugin is unavailable.');

  let afterCompiler: ((input: unknown) => void) | undefined;
  let afterEnvironmentCompile: ((input: unknown) => void) | undefined;
  let beforeStartDevServer: ((input: unknown) => unknown) | undefined;
  let closeDevServer: (() => unknown) | undefined;
  plugin.setup({
    onAfterCreateCompiler: (callback: unknown) => { afterCompiler = callback as (input: unknown) => void; },
    onAfterEnvironmentCompile: (callback: unknown) => { afterEnvironmentCompile = callback as (input: unknown) => void; },
    onBeforeStartDevServer: (callback: unknown) => { beforeStartDevServer = callback as (input: unknown) => unknown; },
    onCloseDevServer: (callback: unknown) => { closeDevServer = callback as () => unknown; },
  });

  const firstAppUpdate = Object.freeze({ environment: { name: 'app' }, isFirstCompile: true, stats: { hasErrors: () => false, hash: 'app-change-a' } });
  const duplicateFirstAppUpdate = Object.freeze({ environment: { name: 'app' }, isFirstCompile: false, stats: { hasErrors: () => false, hash: 'app-change-a' } });
  const appBUpdate = Object.freeze({ environment: { name: 'app' }, isFirstCompile: false, stats: { hasErrors: () => false, hash: 'app-change-b' } });
  const appAUpdate = Object.freeze({ environment: { name: 'app' }, isFirstCompile: false, stats: { hasErrors: () => false, hash: 'app-change-a' } });
  const repeatedAppBUpdate = Object.freeze({ environment: { name: 'app' }, isFirstCompile: false, stats: { hasErrors: () => false, hash: 'app-change-b' } });
  const failedAppUpdate = Object.freeze({ environment: { name: 'app' }, isFirstCompile: false, stats: { hasErrors: () => true } });
  const nonAppUpdate = Object.freeze({ environment: { name: 'widget' }, isFirstCompile: false, stats: { hasErrors: () => false } });

  afterCompiler?.({ environments: { app: {}, widget: {} } });
  afterEnvironmentCompile?.(appBUpdate);
  expect(reloads).toEqual([]);
  beforeStartDevServer?.({ server: { environments: { app: {}, widget: {} } } });
  afterEnvironmentCompile?.(firstAppUpdate);
  afterEnvironmentCompile?.(nonAppUpdate);
  afterEnvironmentCompile?.(failedAppUpdate);
  afterEnvironmentCompile?.(duplicateFirstAppUpdate);
  expect(reloads).toEqual([]);

  afterEnvironmentCompile?.(appBUpdate);
  expect(reloads).toEqual([1]);
  afterEnvironmentCompile?.(appAUpdate);
  expect(reloads).toEqual([1, 2]);
  afterEnvironmentCompile?.(repeatedAppBUpdate);
  expect(reloads).toEqual([1, 2, 3]);

  await closeDevServer?.();
  afterEnvironmentCompile?.(appAUpdate);
  expect(reloads).toEqual([1, 2, 3]);

  beforeStartDevServer?.({ server: { environments: { app: {}, widget: {} } } });
  afterEnvironmentCompile?.(appBUpdate);
  expect(reloads).toEqual([1, 2, 3, 4]);
});

test('keeps compiler-App HMR out of the opaque browser child', () => {
  const config = createRscRuntimeRsbuildConfig({
    compilerRoot: join(tmpdir(), 'rsc-provider-outer-hmr'),
    mode: 'development',
  });
  const app = config.environments?.app as Readonly<{ readonly dev?: unknown }> | undefined;
  expect(app?.dev).toMatchObject({ hmr: false, liveReload: false });
});

test('declares an optional runtime while keeping Claude and Codex artifacts buildable', async () => {
  const copied = await copyProviderExample();
  try {
    const root = copied.projectRoot;
    // Host artifacts package the declared prebuilt payload trees, so building
    // them requires the example's own Rsbuild output to exist in the copy.
    await ensureExampleBuilt();
    for (const payload of ['runtime', 'app']) {
      await cp(join(exampleRoot, 'dist', payload), join(root, 'dist', payload), { recursive: true });
    }
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root }).prepare('dev');

    expect(prepared.source.state).toBe('ready');
    expect(prepared.devRuntime).toMatchObject({
      apps: [expect.objectContaining({ name: 'timeline', resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' })],
      provider: './src/dev/provider.ts',
      servers: [expect.objectContaining({ name: 'timeline', transport: 'stdio' })],
    });
    // One prebuilt hook declaration per host, each carrying its own `--host`
    // argument.
    expect(prepared.model?.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ prebuiltPath: 'runtime/hook/index.js', targets: ['claude'] }),
      expect.objectContaining({ prebuiltPath: 'runtime/hook/index.js', targets: ['codex'] }),
    ]));

    const artifact = await new ArtifactService({ epochStore: new EpochStore({ projectRoot: root }) }).build(prepared);
    if (artifact.outcome !== 'succeeded') throw new Error(JSON.stringify(artifact.diagnostics));
    expect(artifact).toMatchObject({ outcome: 'succeeded' });
    const provider = createDevRuntimeProvider();
    const runtimeStorageRoot = join(root, '.agent-bundle', 'runtime-test');
    expect(provider.descriptor).toEqual({
      environmentVariables: [],
      id: 'rsc-agent-runtime',
      label: 'RSC agent runtime',
      schemaVersion: 1,
    });
    const session = await provider.start({
      artifactStatus: () => Object.freeze({ state: 'missing' as const }),
      emit: () => undefined,
      environment: Object.freeze({}),
      projectRoot: root,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-test',
      signal: new AbortController().signal,
      storageRoot: runtimeStorageRoot,
    });
    try {
      await waitFor(() => session.status().state === 'active');
      expect(session.status()).toMatchObject({ hmrReady: true, state: 'active' });
      expect(session.clientSurface('mcp.edit-timeline')).toMatchObject({
        entryPath: '/edit-timeline-v1.html',
        httpOrigin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/u),
        httpPathPrefixes: ['/'],
        subscribeReload: expect.any(Function),
        surfaceId: 'mcp.edit-timeline',
      });
      expect(session.status()).not.toHaveProperty('clientSurface');
      expect(session.surfaces()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'hook' }),
        expect.objectContaining({ id: 'mcp.render_edit_timeline', kind: 'mcp-tool' }),
        expect.objectContaining({ id: 'mcp.edit-timeline', kind: 'mcp-resource' }),
        expect.objectContaining({ id: 'mcp.timeline', kind: 'mcp-app' }),
      ]));
      const registry = session.mcpRegistry.snapshot();
      expect(registry).toMatchObject({ runtimeGenerationId: expect.any(String) });
      expect([...new Set([
        registry!.definitionDigest,
        registry!.servers[0]!.serverDigest,
        registry!.transportDigest,
      ])]).toHaveLength(3);

      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: registry!.runtimeGenerationId,
        surfaceId: 'mcp.timeline',
      })).resolves.toMatchObject({ contentType: 'text/html' });
      await expect(session.readAsset({
        path: ['..'],
        runtimeGenerationId: registry!.runtimeGenerationId,
        surfaceId: 'mcp.timeline',
      })).resolves.toBeUndefined();
      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: registry!.runtimeGenerationId,
        surfaceId: 'mcp.unknown',
      })).resolves.toBeUndefined();
      for (const path of [
        ['rsc', 'missing.html'],
        ['..'],
        ['.'],
        ['rsc\\index.html'],
        ['rsc', 'index\0.html'],
        ['%2e%2e'],
      ]) {
        await expect(session.readAsset({
          path,
          runtimeGenerationId: registry!.runtimeGenerationId,
          surfaceId: 'mcp.timeline',
        })).resolves.toBeUndefined();
      }
      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: '',
        surfaceId: 'mcp.timeline',
      })).resolves.toBeUndefined();
      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: 'generation-pruned',
        surfaceId: 'mcp.timeline',
      })).resolves.toBeUndefined();
      const assetPath = join(
        runtimeStorageRoot,
        'generation-store',
        'generations',
        registry!.runtimeGenerationId,
        'widget',
        'rsc',
        'index.html',
      );
      const originalAsset = await readFile(assetPath);
      const readTimelineAsset = () => session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: registry!.runtimeGenerationId,
        surfaceId: 'mcp.timeline',
      });
      const digestTampered = Buffer.from(originalAsset);
      digestTampered[0] = digestTampered[0] === 0 ? 1 : 0;
      await writeFile(assetPath, digestTampered);
      await expect(readTimelineAsset()).resolves.toBeUndefined();
      await writeFile(assetPath, originalAsset);
      await writeFile(assetPath, Buffer.alloc((8 * 1024 * 1024) + 1));
      await expect(readTimelineAsset()).resolves.toBeUndefined();
      await writeFile(assetPath, originalAsset);
      await rm(assetPath);
      await symlink(join(root, 'src', 'definition.ts'), assetPath);
      await expect(readTimelineAsset()).resolves.toBeUndefined();
      await rm(assetPath);
      await mkdir(assetPath);
      await expect(readTimelineAsset()).resolves.toBeUndefined();
      await rm(assetPath, { recursive: true });
      await writeFile(assetPath, originalAsset);

      const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
      const initialCapabilities = mcp.snapshot().connection.capabilities;
      if (initialCapabilities === undefined) throw new Error('Expected runtime MCP capabilities.');
      expect(initialCapabilities).toEqual({ resources: {}, tools: {} });
      expect(Object.isFrozen(initialCapabilities)).toBe(true);
      expect(Object.isFrozen(initialCapabilities.resources)).toBe(true);
      expect(Object.isFrozen(initialCapabilities.tools)).toBe(true);
      const list = await mcp.execute({ expectedSessionRevision: mcp.snapshot().binding.sessionRevision, kind: 'list-tools' });
      expect(list.value).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'render_edit_timeline' })]));
      const originalBinding = mcp.snapshot().binding;
      await session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        apps: prepared.devRuntime!.apps.map((app) => ({
          ...app,
          _meta: { ...app._meta, 'openai/widgetDescription': 'Updated timeline description.' },
        })),
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-app-metadata`,
      });
      const reconciledRegistry = session.mcpRegistry.snapshot();
      expect(reconciledRegistry!.definitionDigest).not.toBe(registry!.definitionDigest);
      expect(reconciledRegistry).toMatchObject({
        registryRevision: originalBinding.registryRevision + 1,
        runtimeGenerationId: registry!.runtimeGenerationId,
      });
      expect(mcp.snapshot().binding.sessionRevision).toBe(originalBinding.sessionRevision + 1);
      await expect(mcp.execute({ expectedSessionRevision: originalBinding.sessionRevision, kind: 'list-tools' })).rejects.toThrow();
      await expect(mcp.execute({ expectedSessionRevision: mcp.snapshot().binding.sessionRevision, kind: 'list-tools' })).resolves.toMatchObject({
        vector: { runtimeGenerationId: registry!.runtimeGenerationId },
      });
      expect(mcp.snapshot().connection.capabilities).toEqual({ resources: {}, tools: {} });
      await session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-p1-revert`,
      });
      const revertedRegistry = session.mcpRegistry.snapshot();
      expect(revertedRegistry).toMatchObject({
        definitionDigest: registry!.definitionDigest,
        registryRevision: originalBinding.registryRevision + 2,
        runtimeGenerationId: registry!.runtimeGenerationId,
      });
      const revertedRevision = mcp.snapshot().binding.sessionRevision;
      await session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-p3-repeat`,
      });
      expect(session.mcpRegistry.snapshot()).toMatchObject({
        definitionDigest: registry!.definitionDigest,
        registryRevision: revertedRegistry!.registryRevision,
      });
      expect(mcp.snapshot().binding.sessionRevision).toBe(revertedRevision);
      await mcp.close();
      const closing = session.close();
      await expect(session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-close-race`,
      })).rejects.toThrow('RSC runtime session is closed.');
      await closing;
      expect(session.status()).toMatchObject({ hmrReady: false, state: 'closed' });
      expect(session.clientSurface('mcp.edit-timeline')).toBeUndefined();
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('resets state through the dynamically loaded copied provider', async () => {
  const copied = await copyProviderExample();
  const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-dynamic-reset');
  const controller = new AbortController();
  let session: Awaited<ReturnType<Awaited<ReturnType<typeof resolveDevRuntimeProvider>>['start']>> | undefined;
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const provider = await resolveDevRuntimeProvider(copied.projectRoot, prepared.devRuntime!);
    session = await provider.start(startContext({
      preparedRuntime: prepared.devRuntime!,
      projectRoot: copied.projectRoot,
      providerSessionId: 'provider-dynamic-reset',
      signal: controller.signal,
      storageRoot,
    }));
    await waitFor(() => session!.status().state === 'active');
    const activeVector = session.status().activeVector;
    if (activeVector === undefined) throw new Error('The copied provider did not activate a runtime generation.');

    await expect(session.resetState({
      expectedGenerationId: activeVector.runtimeGenerationId,
      stateStoreId: activeVector.stateStoreId,
    })).resolves.toEqual({ stateStoreId: activeVector.stateStoreId, stateVersion: 1 });
  } finally {
    controller.abort();
    await session?.close();
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('rejects an already-aborted provider start before creating a runtime session', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const controller = new AbortController();
    const reason = new Error('provider startup cancelled');
    controller.abort(reason);

    await expect(createDevRuntimeProvider().start({
      artifactStatus: () => Object.freeze({ state: 'missing' as const }),
      emit: () => undefined,
      environment: Object.freeze({}),
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-aborted',
      signal: controller.signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-aborted'),
    })).rejects.toBe(reason);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('retries an identical compiler cohort after an asynchronous provider activation failure', async () => {
  const outcomes = [deferred<RscRuntimeActivationOutcome>(), deferred<RscRuntimeActivationOutcome>()];
  const captures: boolean[] = [];
  let enqueueCount = 0;
  const observer = compileObserver({
    beginCompletedCohort: () => `attempt-${String(captures.length + 1)}`,
    capture: async (input) => {
      captures.push(input.cohortChanged);
      return input.cohortChanged ? snapshotFor(input.attemptId, input.sourceRevision) : undefined;
    },
    enqueue: () => outcomes[enqueueCount++]!.promise,
    failAttempt: () => undefined,
    observeCompileStart: () => undefined,
  });

  await observer.compile();
  outcomes[0]!.resolve('failed');
  await Promise.resolve();
  await observer.compile();
  outcomes[1]!.resolve('activated');
  await Promise.resolve();
  await observer.compile();

  expect(captures).toEqual([true, true, false]);
  expect(enqueueCount).toBe(2);
});

test('classifies a same-hash compiler cohort as unchanged while its activation is pending', async () => {
  const activation = deferred<RscRuntimeActivationOutcome>();
  const captures: boolean[] = [];
  let attempts = 0;
  let enqueueCount = 0;
  const observer = compileObserver({
    beginCompletedCohort: () => `attempt-${String(++attempts)}`,
    capture: async (input) => {
      captures.push(input.cohortChanged);
      return input.cohortChanged ? snapshotFor(input.attemptId, input.sourceRevision) : undefined;
    },
    enqueue: () => {
      enqueueCount += 1;
      return activation.promise;
    },
    failAttempt: () => undefined,
    observeCompileStart: () => undefined,
  });

  await observer.compile();
  await observer.compile();

  expect(captures).toEqual([true, false]);
  expect(enqueueCount).toBe(1);
  activation.resolve('activated');
});

test('classifies direct compiler errors as source build failures without capture or enqueue', async () => {
  const captured: string[] = [];
  const enqueued: string[] = [];
  const failures: unknown[][] = [];
  const observer = compileObserver({
    beginCompletedCohort: () => 'attempt-source-build',
    capture: async (input) => {
      captured.push(input.attemptId);
      return snapshotFor(input.attemptId, input.sourceRevision);
    },
    enqueue: (snapshot) => {
      enqueued.push(snapshot.attemptId);
      return 'activated';
    },
    failAttempt: (...input: unknown[]) => { failures.push(input); },
    observeCompileStart: () => undefined,
  });

  await observer.compile({ hasErrors: true });

  expect(captured).toEqual([]);
  expect(enqueued).toEqual([]);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.[0]).toBe('attempt-source-build');
  expect(failures[0]?.[2]).toBe('source-build');
});

test('recaptures an unchanged successful cohort after a source build failure', async () => {
  const captured: boolean[] = [];
  const observer = compileObserver({
    beginCompletedCohort: () => `attempt-${String(captured.length + 1)}`,
    capture: async (input) => {
      captured.push(input.cohortChanged);
      return snapshotFor(input.attemptId, input.sourceRevision);
    },
    enqueue: () => 'activated',
    failAttempt: () => undefined,
    observeCompileStart: () => undefined,
  });

  await observer.compile();
  await observer.compile({ hasErrors: true });
  await observer.compile();

  expect(captured).toEqual([true, true]);
});

test('keeps malformed compiler stats in the provider lifecycle failure lane', async () => {
  const failures: unknown[][] = [];
  const observer = compileObserver({
    beginCompletedCohort: () => 'attempt-malformed-stats',
    capture: async (input) => snapshotFor(input.attemptId, input.sourceRevision),
    enqueue: () => 'activated',
    failAttempt: (...input: unknown[]) => { failures.push(input); },
    observeCompileStart: () => undefined,
  });

  await observer.compile({ children: [] });

  expect(failures).toHaveLength(1);
  expect(failures[0]?.[0]).toBe('attempt-malformed-stats');
  expect(failures[0]?.[2]).toBe('provider-lifecycle');
});

test('derives identity from completed cohorts when before callbacks are coalesced, missing, or duplicated', async () => {
  let cohorts = 0;
  let observedStarts = 0;
  const captures: string[] = [];
  const failures: unknown[][] = [];
  const observer = compileObserver({
    beginCompletedCohort: () => `cohort-${String(++cohorts)}`,
    capture: async (input) => {
      captures.push(input.attemptId);
      return undefined;
    },
    enqueue: () => undefined,
    failAttempt: (...input: unknown[]) => { failures.push(input); },
    observeCompileStart: () => { observedStarts += 1; },
  });

  // Coalesced invalidation: two pre-compile callbacks, one completion.
  observer.observeCompileStart();
  observer.observeCompileStart();
  await observer.completeAttempt();
  // Missing pre-compile callback: a completion with no before callback at
  // all still allocates the next identity and is processed normally.
  await observer.completeAttempt({ children: [{ hash: 'rsc-2', name: 'rsc' }, { hash: 'widget-2', name: 'widget' }, { hash: 'app-2', name: 'app' }] });
  // Duplicated pre-compile callback after everything settled: advisory only.
  observer.observeCompileStart();

  expect(observedStarts).toBe(3);
  expect(captures).toEqual(['cohort-1', 'cohort-2']);
  expect(failures).toEqual([]);
});

test('assigns ascending completed-cohort identity to duplicated and reordered completion callbacks', async () => {
  let cohorts = 0;
  const captures: Array<Readonly<{ readonly attemptId: string; readonly cohortChanged: boolean; readonly sourceRevision: string }>> = [];
  const enqueued: string[] = [];
  const failures: unknown[][] = [];
  const observer = compileObserver({
    beginCompletedCohort: () => `cohort-${String(++cohorts)}`,
    capture: async (input) => {
      captures.push(Object.freeze({ attemptId: input.attemptId, cohortChanged: input.cohortChanged, sourceRevision: input.sourceRevision }));
      return input.cohortChanged ? snapshotFor(input.attemptId, input.sourceRevision) : undefined;
    },
    enqueue: (snapshot) => {
      enqueued.push(snapshot.attemptId);
      return 'activated';
    },
    failAttempt: (...input: unknown[]) => { failures.push(input); },
    observeCompileStart: () => undefined,
  });

  const newer = [{ hash: 'rsc-newer', name: 'rsc' }, { hash: 'widget-newer', name: 'widget' }, { hash: 'app-newer', name: 'app' }];
  const older = [{ hash: 'rsc-older', name: 'rsc' }, { hash: 'widget-older', name: 'widget' }, { hash: 'app-older', name: 'app' }];
  // Reordered delivery: the completion for the newer compile arrives first.
  // Identity binds to completion arrival, so the last-delivered cohort is
  // the authoritative one - there is no queue to pair either callback with
  // an older observation.
  await observer.completeAttempt({ children: newer });
  await observer.completeAttempt({ children: older });
  // Duplicated completion: the same MultiStats delivered again is an
  // unchanged cohort no-op under a fresh identity, never a mispair.
  await observer.completeAttempt({ children: older });

  expect(captures.map((capture) => capture.attemptId)).toEqual(['cohort-1', 'cohort-2', 'cohort-3']);
  expect(captures.map((capture) => capture.cohortChanged)).toEqual([true, true, false]);
  expect(captures[0]!.sourceRevision).not.toBe(captures[1]!.sourceRevision);
  expect(captures[1]!.sourceRevision).toBe(captures[2]!.sourceRevision);
  expect(enqueued).toEqual(['cohort-1', 'cohort-2']);
  expect(failures).toEqual([]);
});

test('treats skewed child invalidations as distinct completed cohorts in completion order', async () => {
  let cohorts = 0;
  const captures: Array<Readonly<{ readonly attemptId: string; readonly cohortChanged: boolean }>> = [];
  const failures: unknown[][] = [];
  const observer = compileObserver({
    beginCompletedCohort: () => `cohort-${String(++cohorts)}`,
    capture: async (input) => {
      captures.push(Object.freeze({ attemptId: input.attemptId, cohortChanged: input.cohortChanged }));
      return input.cohortChanged ? snapshotFor(input.attemptId, input.sourceRevision) : undefined;
    },
    enqueue: () => 'activated',
    failAttempt: (...input: unknown[]) => { failures.push(input); },
    observeCompileStart: () => undefined,
  });

  // MultiCompiler children invalidating at different times surface as
  // overlapping before callbacks and completions whose child hashes advance
  // one child at a time. Every distinct completed pair is a fresh cohort.
  observer.observeCompileStart();
  await observer.completeAttempt({ children: [{ hash: 'rsc-1', name: 'rsc' }, { hash: 'widget-1', name: 'widget' }, { hash: 'app-1', name: 'app' }] });
  observer.observeCompileStart();
  observer.observeCompileStart();
  await observer.completeAttempt({ children: [{ hash: 'rsc-2', name: 'rsc' }, { hash: 'widget-1', name: 'widget' }, { hash: 'app-1', name: 'app' }] });
  await observer.completeAttempt({ children: [{ hash: 'rsc-2', name: 'rsc' }, { hash: 'widget-2', name: 'widget' }, { hash: 'app-2', name: 'app' }] });

  expect(captures.map((capture) => capture.attemptId)).toEqual(['cohort-1', 'cohort-2', 'cohort-3']);
  expect(captures.map((capture) => capture.cohortChanged)).toEqual([true, true, true]);
  expect(failures).toEqual([]);
});

test('aggregates owned resource closer failures', async () => {
  const ledger = new ResourceLedger();
  const first = new Error('first closer failed');
  const second = new Error('second closer failed');
  ledger.add(async () => { throw first; });
  ledger.add(async () => { throw second; });

  await expect(ledger.close()).rejects.toMatchObject({
    errors: expect.arrayContaining([first, second]),
    message: 'RSC runtime startup cleanup failed.',
  });
});

test('records one failed event when capture and observer finalization both fail an attempt', async () => {
  const copied = await copyProviderExample();
  try {
    await writeFile(join(copied.projectRoot, 'src', 'definition.ts'), 'export const runtimeDefinition: any = {};\n');
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const events: Array<{ readonly type: string }> = [];
    const session = await RsbuildRuntimeSession.start({
      ...startContext({
        projectRoot: copied.projectRoot,
        preparedRuntime: prepared.devRuntime!,
        providerSessionId: 'provider-double-failure',
        signal: new AbortController().signal,
        storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-double-failure'),
      }),
      emit: (event) => { events.push(event); },
    });
    try {
      await waitFor(() => session.status().state === 'degraded');
      expect(session.status().diagnostics).toEqual([{
        code: 'AB8200',
        message: expect.any(String),
        phase: 'provider-lifecycle',
        severity: 'error',
      }]);
      expect(events.filter((event) => event.type === 'runtime.generation.failed')).toHaveLength(1);
      await expect(readdir(join(copied.projectRoot, '.agent-bundle', 'runtime-double-failure', 'generation-store', 'staging'))).resolves.toEqual([]);
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('keeps the active generation while publishing a source build diagnostic before its failed event', async () => {
  const copied = await copyProviderExample();
  let session: RsbuildRuntimeSession | undefined;
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const events: Array<{ readonly type: string }> = [];
    const failedStatuses: Array<ReturnType<RsbuildRuntimeSession['status']>> = [];
    session = await RsbuildRuntimeSession.start({
      ...startContext({
        projectRoot: copied.projectRoot,
        preparedRuntime: prepared.devRuntime!,
        providerSessionId: 'provider-source-build-retention',
        signal: new AbortController().signal,
        storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-source-build-retention'),
      }),
      emit: (event) => {
        events.push(event);
        if (event.type === 'runtime.generation.failed' && session !== undefined) failedStatuses.push(session.status());
      },
    });
    await waitFor(() => session?.status().state === 'active');
    const beforeStatus = session.status();
    const beforeSurfaces = session.surfaces();
    const beforeRuns = session.runs(50);

    await introduceWorkerSyntaxError(copied.projectRoot);
    await waitFor(() => events.filter((event) => event.type === 'runtime.generation.failed').length === 1);

    expect(failedStatuses).toHaveLength(1);
    expect(failedStatuses[0]).toMatchObject({
      activeVector: beforeStatus.activeVector,
      diagnostics: [{
        code: 'AB8206',
        message: 'RSC runtime source build failed.',
        phase: 'source/build',
        severity: 'error',
      }],
      lastGoodVector: beforeStatus.lastGoodVector,
      state: 'active',
    });
    expect(session.status()).toEqual(failedStatuses[0]);
    expect(session.surfaces()).toEqual(beforeSurfaces);
    expect(session.runs(50)).toEqual(beforeRuns);
  } finally {
    await session?.close();
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 60_000 * timeScale);

test('drains a deferred generation pipeline before close without publishing late lifecycle events', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const reached = deferred<void>();
    const release = deferred<void>();
    const events: Array<{ readonly type: string }> = [];
    let deferActivation = false;
    let held = false;
    const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-close-deferred-generation');
    const session = await RsbuildRuntimeSession.start({
      ...startContext({
        projectRoot: copied.projectRoot,
        preparedRuntime: prepared.devRuntime!,
        providerSessionId: 'provider-close-deferred-generation',
        signal: new AbortController().signal,
        storageRoot,
      }),
      emit: (event) => { events.push(event); },
    }, {
      beforeGenerationCapture: async () => {
        if (!deferActivation || held) return;
        held = true;
        reached.resolve();
        await release.promise;
      },
    });
    try {
      await waitFor(() => session.status().state === 'active');
      deferActivation = true;
      await changeWorkerImplementation(copied.projectRoot, 'close-deferred-generation');
      const captureReached = await Promise.race([
        reached.promise.then(() => true),
        new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, 5_000); }),
      ]);
      expect(captureReached).toBe(true);
      const eventCountBeforeClose = events.length;
      const closing = session.close();
      let closed = false;
      void closing.then(() => { closed = true; });
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect(events).toHaveLength(eventCountBeforeClose);
      await expect(lstat(join(storageRoot, 'generation-store', 'staging'))).rejects.toThrow();
    } finally {
      release.resolve();
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('binds renamed and added App surfaces to the active generation assets without restoring removed surfaces', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-reconciled-app-assets',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-reconciled-app-assets'),
    }));
    try {
      await waitFor(() => session.status().state === 'active');
      const runtimeGenerationId = session.mcpRegistry.snapshot()!.runtimeGenerationId;
      const original = prepared.devRuntime!.apps[0]!;
      await session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        apps: [
          { ...original, name: 'timeline-renamed' },
          { ...original, id: `${original.id}-added`, name: 'timeline-added' },
        ],
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-reconciled-app-assets`,
      });

      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId,
        surfaceId: 'mcp.timeline-renamed',
      })).resolves.toMatchObject({ contentType: 'text/html' });
      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId,
        surfaceId: 'mcp.timeline-added',
      })).resolves.toMatchObject({ contentType: 'text/html' });
      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId,
        surfaceId: 'mcp.timeline',
      })).resolves.toBeUndefined();

      await changeWorkerImplementation(copied.projectRoot, 'reconciled-app-assets-generation-two');
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== runtimeGenerationId);
      const nextRuntimeGenerationId = session.status().activeVector!.runtimeGenerationId;
      for (const generationId of [runtimeGenerationId, nextRuntimeGenerationId]) {
        await expect(session.readAsset({
          path: ['rsc', 'index.html'],
          runtimeGenerationId: generationId,
          surfaceId: 'mcp.timeline-renamed',
        })).resolves.toMatchObject({ contentType: 'text/html' });
        await expect(session.readAsset({
          path: ['rsc', 'index.html'],
          runtimeGenerationId: generationId,
          surfaceId: 'mcp.timeline-added',
        })).resolves.toMatchObject({ contentType: 'text/html' });
        await expect(session.readAsset({
          path: ['rsc', 'index.html'],
          runtimeGenerationId: generationId,
          surfaceId: 'mcp.timeline',
        })).resolves.toBeUndefined();
      }
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('rebinds current App surfaces across retained generations after a later configuration reconcile', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-reconciled-retained-app-assets',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-reconciled-retained-app-assets'),
    }));
    try {
      await waitFor(() => session.status().state === 'active');
      const firstGenerationId = session.mcpRegistry.snapshot()!.runtimeGenerationId;
      await changeWorkerImplementation(copied.projectRoot, 'reconciled-retained-app-assets-generation-two');
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== firstGenerationId);
      const secondGenerationId = session.status().activeVector!.runtimeGenerationId;
      const original = prepared.devRuntime!.apps[0]!;
      await session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        apps: [
          { ...original, name: 'timeline-renamed' },
          { ...original, id: `${original.id}-added`, name: 'timeline-added' },
        ],
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-reconciled-retained-app-assets`,
      });

      for (const generationId of [firstGenerationId, secondGenerationId]) {
        await expect(session.readAsset({
          path: ['rsc', 'index.html'],
          runtimeGenerationId: generationId,
          surfaceId: 'mcp.timeline-renamed',
        })).resolves.toMatchObject({ contentType: 'text/html' });
        await expect(session.readAsset({
          path: ['rsc', 'index.html'],
          runtimeGenerationId: generationId,
          surfaceId: 'mcp.timeline-added',
        })).resolves.toMatchObject({ contentType: 'text/html' });
        await expect(session.readAsset({
          path: ['rsc', 'index.html'],
          runtimeGenerationId: generationId,
          surfaceId: 'mcp.timeline',
        })).resolves.toBeUndefined();
      }
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('keeps the same MCP session and revision across an implementation-only generation', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-implementation-only',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-implementation-only'),
    }));
    try {
      await waitFor(() => session.status().state === 'active');
      const beforeGeneration = session.mcpRegistry.snapshot()!.runtimeGenerationId;
      const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
      try {
        const before = mcp.snapshot();
        await changeWorkerImplementation(copied.projectRoot, 'implementation-only');
        await waitFor(() => session.status().activeVector?.runtimeGenerationId !== beforeGeneration);
        const after = mcp.snapshot();
        expect(after.binding).toMatchObject({
          sessionId: before.binding.sessionId,
          sessionRevision: before.binding.sessionRevision,
        });
        await expect(mcp.execute({
          expectedSessionRevision: after.binding.sessionRevision,
          kind: 'list-tools',
        })).resolves.toMatchObject({
          sessionId: before.binding.sessionId,
          sessionRevision: before.binding.sessionRevision,
          vector: { runtimeGenerationId: session.status().activeVector!.runtimeGenerationId },
        });
      } finally {
        await mcp.close();
      }
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('restarts and relists an open MCP session after a warm-cache definition change', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-definition-change',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-definition-change'),
    }));
    try {
      await waitFor(() => session.status().state === 'active');
      const beforeRegistry = session.mcpRegistry.snapshot()!;
      const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
      try {
        const before = mcp.snapshot().binding;
        await changeDefinition(copied.projectRoot, 'Read the freshly rebuilt shared runtime state.');
        await waitFor(() => session.mcpRegistry.snapshot()!.definitionDigest !== beforeRegistry.definitionDigest);
        const afterRegistry = session.mcpRegistry.snapshot()!;
        const after = mcp.snapshot();
        expect(afterRegistry.runtimeGenerationId).not.toBe(beforeRegistry.runtimeGenerationId);
        expect(after.binding.sessionRevision).toBe(before.sessionRevision + 1);
        await expect(mcp.execute({
          expectedSessionRevision: after.binding.sessionRevision,
          kind: 'list-tools',
        })).resolves.toMatchObject({ vector: { runtimeGenerationId: afterRegistry.runtimeGenerationId } });
      } finally {
        await mcp.close();
      }
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('uses the live registry authority after a transport-only runtime MCP reconciliation', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-live-transport-authority',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-live-transport-authority'),
    }));
    try {
      await waitFor(() => session.status().state === 'active');
      const initialRegistry = session.mcpRegistry.snapshot()!;
      const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
      try {
        const initialBinding = mcp.snapshot().binding;
        const definitionPrepared = Object.freeze({
          ...prepared.devRuntime!,
          apps: prepared.devRuntime!.apps.map((app) => Object.freeze({
            ...app,
            _meta: Object.freeze({ ...app._meta, 'openai/widgetDescription': 'Live definition authority.' }),
          })),
          sourceRevision: `${prepared.devRuntime!.sourceRevision}-definition-v2`,
        });
        await session.reconcilePreparedRuntime(definitionPrepared);
        const definitionRegistry = session.mcpRegistry.snapshot()!;
        const definitionBinding = mcp.snapshot().binding;
        expect(definitionRegistry).toMatchObject({
          registryRevision: initialRegistry.registryRevision + 1,
          runtimeGenerationId: initialRegistry.runtimeGenerationId,
          transportDigest: initialRegistry.transportDigest,
        });
        expect(definitionRegistry.definitionDigest).not.toBe(initialRegistry.definitionDigest);
        expect(definitionBinding).toMatchObject({
          definitionDigest: definitionRegistry.definitionDigest,
          registryRevision: definitionRegistry.registryRevision,
          sessionId: initialBinding.sessionId,
          sessionRevision: initialBinding.sessionRevision + 1,
        });
        await expect(mcp.execute({ expectedSessionRevision: initialBinding.sessionRevision, kind: 'list-tools' })).rejects.toThrow();
        const definitionRun = await session.invoke({
          expectedGenerationId: definitionRegistry.runtimeGenerationId,
          input: {},
          surfaceId: 'mcp.render_edit_timeline',
          target: 'portable',
        });
        expect(definitionRun).toMatchObject({
          status: 'succeeded', vector: { runtimeGenerationId: definitionRegistry.runtimeGenerationId },
        });
        if (definitionRun.status !== 'succeeded' || definitionRun.result.app === undefined) throw new Error('Definition reconciliation run omitted its Runtime App binding.');
        const definitionAppBinding = definitionRun.result.app.mcpBinding;
        expect(definitionAppBinding).toMatchObject({
          definitionDigest: definitionRegistry.definitionDigest,
          registryRevision: definitionRegistry.registryRevision,
          sessionId: expect.any(String),
          sessionRevision: expect.any(Number),
          transportDigest: definitionRegistry.transportDigest,
        });

        await session.reconcilePreparedRuntime({
          ...definitionPrepared,
          servers: definitionPrepared.servers.map((server) => Object.freeze({
            ...server,
            env: Object.freeze({ ...(server.env ?? {}), TIMELINE_TRANSPORT_SENTINEL: 'transport-v2' }),
          })),
          sourceRevision: `${prepared.devRuntime!.sourceRevision}-transport-v2`,
        });
        const registry = session.mcpRegistry.snapshot()!;
        const currentBinding = mcp.snapshot().binding;
        expect(registry).toMatchObject({
          definitionDigest: definitionRegistry.definitionDigest,
          registryRevision: definitionRegistry.registryRevision + 1,
          runtimeGenerationId: definitionRegistry.runtimeGenerationId,
        });
        expect(registry.transportDigest).not.toBe(definitionRegistry.transportDigest);
        expect(currentBinding).toMatchObject({
          registryRevision: registry.registryRevision,
          sessionId: definitionBinding.sessionId,
          sessionRevision: definitionBinding.sessionRevision + 1,
          transportDigest: registry.transportDigest,
        });
        await expect(mcp.execute({ expectedSessionRevision: definitionBinding.sessionRevision, kind: 'list-tools' })).rejects.toThrow();

        const appRun = await session.invoke({
          expectedGenerationId: registry.runtimeGenerationId,
          input: {},
          surfaceId: 'mcp.render_edit_timeline',
          target: 'portable',
        });
        expect(appRun).toMatchObject({
          status: 'succeeded', vector: { runtimeGenerationId: registry.runtimeGenerationId },
        });
        if (appRun.status !== 'succeeded' || appRun.result.app === undefined) throw new Error('Transport reconciliation run omitted its Runtime App binding.');
        expect(appRun.result.app.mcpBinding).toMatchObject({
          definitionDigest: registry.definitionDigest,
          registryRevision: registry.registryRevision,
          sessionId: definitionAppBinding.sessionId,
          sessionRevision: definitionAppBinding.sessionRevision + 1,
          transportDigest: registry.transportDigest,
        });
        await expect(mcp.execute({
          expectedSessionRevision: currentBinding.sessionRevision,
          kind: 'read-resource',
          uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
        })).resolves.toMatchObject({
          sessionId: currentBinding.sessionId,
          sessionRevision: currentBinding.sessionRevision,
          vector: { runtimeGenerationId: registry.runtimeGenerationId },
        });
        await expect(mcp.execute({
          arguments: { limit: 1 },
          expectedSessionRevision: currentBinding.sessionRevision,
          kind: 'call-tool',
          name: 'render_edit_timeline',
        })).resolves.toMatchObject({
          sessionId: currentBinding.sessionId,
          sessionRevision: currentBinding.sessionRevision,
          vector: { runtimeGenerationId: registry.runtimeGenerationId },
        });
      } finally {
        await mcp.close();
      }
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('rejects MCP admission until a deferred public prepared-config restart has relisted', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const relistReached = deferred<void>();
    const allowRelist = deferred<void>();
    let deferRelist = false;
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-deferred-restart',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-deferred-restart'),
    }), {
      beforeMcpRelist: async () => {
        if (!deferRelist) return;
        relistReached.resolve();
        await allowRelist.promise;
      },
    });
    try {
      await waitFor(() => session.status().state === 'active');
      const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
      try {
        expect(mcp.snapshot().connection.capabilities).toEqual({ resources: {}, tools: {} });
        const before = mcp.snapshot().binding;
        deferRelist = true;
        const reconciling = session.reconcilePreparedRuntime({
          ...prepared.devRuntime!,
          apps: prepared.devRuntime!.apps.map((app) => ({
            ...app,
            _meta: { ...app._meta, 'openai/widgetDescription': 'Restart after deferred relist.' },
          })),
          sourceRevision: `${prepared.devRuntime!.sourceRevision}-deferred-public-restart`,
        });
        await relistReached.promise;
        const restarting = mcp.snapshot();
        expect(restarting).toMatchObject({ state: 'restarting' });
        await expect(mcp.execute({
          expectedSessionRevision: restarting.binding.sessionRevision,
          kind: 'list-tools',
        })).rejects.toThrow('Runtime MCP session is restarting.');
        allowRelist.resolve();
        await reconciling;
        expect(mcp.snapshot()).toMatchObject({
          binding: { sessionRevision: before.sessionRevision + 1 },
          state: 'ready',
        });
        const restartedCapabilities = mcp.snapshot().connection.capabilities;
        if (restartedCapabilities === undefined) throw new Error('Expected restarted runtime MCP capabilities.');
        expect(restartedCapabilities).toEqual({ resources: {}, tools: {} });
        expect(Object.isFrozen(restartedCapabilities)).toBe(true);
        expect(Object.isFrozen(restartedCapabilities.resources)).toBe(true);
        expect(Object.isFrozen(restartedCapabilities.tools)).toBe(true);
      } finally {
        await mcp.close();
      }
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000 * timeScale);

test('aborts stale activation transactions at both private preparation boundaries', async () => {
  for (const phase of ['store', 'registry'] as const) {
    const copied = await copyProviderExample();
    try {
      const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
      const reached = deferred<void>();
      const allow = deferred<void>();
      const events: Array<{ readonly runtimeGenerationId?: string; readonly type: string }> = [];
      let armBarrier = false;
      let held = false;
      const session = await RsbuildRuntimeSession.start({
        ...startContext({
          projectRoot: copied.projectRoot,
          preparedRuntime: prepared.devRuntime!,
          providerSessionId: `provider-${phase}-prepare`,
          signal: new AbortController().signal,
          storageRoot: join(copied.projectRoot, '.agent-bundle', `runtime-${phase}-prepare`),
        }),
        emit: (event) => { events.push(event); },
      }, {
        afterActivationPrepare: async (input) => {
          if (!armBarrier || held || input.phase !== phase) return;
          held = true;
          reached.resolve();
          await allow.promise;
        },
      });
      try {
        await waitFor(() => session.status().state === 'active');
        const firstGeneration = session.mcpRegistry.snapshot()!.runtimeGenerationId;
        const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
        try {
          const firstBinding = mcp.snapshot().binding;
          armBarrier = true;
          await changeDefinition(copied.projectRoot, `Read state after ${phase} preparation.`);
          await reached.promise;
          expect(session.mcpRegistry.snapshot()).toMatchObject({ runtimeGenerationId: firstGeneration });
          const reconciled = session.reconcilePreparedRuntime({
            ...prepared.devRuntime!,
            apps: prepared.devRuntime!.apps.map((app) => ({
              ...app,
              source: './src/widget/App.tsx',
            })),
            sourceRevision: `${prepared.devRuntime!.sourceRevision}-${phase}-superseding-prepared`,
          });
          allow.resolve();
          await reconciled;
          await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
          await expect(session.readAsset({
            path: ['rsc', 'index.html'],
            runtimeGenerationId: 'generation-2',
            surfaceId: 'mcp.timeline',
          })).resolves.toBeUndefined();
          expect(session.mcpRegistry.snapshot()).toMatchObject({ runtimeGenerationId: firstGeneration });
          expect(mcp.snapshot().binding).toMatchObject({
            sessionId: firstBinding.sessionId,
            sessionRevision: firstBinding.sessionRevision,
          });
          expect(events.filter((event) => event.type === 'runtime.generation.activated' && event.runtimeGenerationId === 'generation-2')).toHaveLength(0);
          armBarrier = false;
          await changeWorkerImplementation(copied.projectRoot, `${phase}-current-generation`);
          await waitFor(() => session.status().activeVector?.runtimeGenerationId !== firstGeneration);
          expect(session.status().activeVector?.runtimeGenerationId).not.toBe('generation-2');
          expect(mcp.snapshot().binding.sessionRevision).toBe(firstBinding.sessionRevision + 1);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    } finally {
      await rm(copied.workspaceRoot, { force: true, recursive: true });
    }
  }
}, 60_000 * timeScale);

test('commits a compiled generation across an equivalent prepared-runtime revision', { timeout: 0 }, async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const reached = deferred<void>();
    const allow = deferred<void>();
    let armBarrier = false;
    let held = false;
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-equivalent-prepared-revision',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-equivalent-prepared-revision'),
    }), {
      afterActivationPrepare: async (input) => {
        if (!armBarrier || held || input.phase !== 'store') return;
        held = true;
        reached.resolve();
        await allow.promise;
      },
    });
    try {
      await waitFor(() => session.status().state === 'active');
      const firstGeneration = session.mcpRegistry.snapshot()!.runtimeGenerationId;
      armBarrier = true;
      await changeDefinition(copied.projectRoot, 'Read state after equivalent prepared revision.');
      await reached.promise;
      const reconciled = session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-equivalent-prepared`,
      });
      allow.resolve();
      await reconciled;

      // The committed generation is asserted relative to the first one, not by
      // ordinal: multi-compiler watch delivery can skew across the rsc and
      // widget children under load, so one source change may burn more than
      // one generation ordinal before the session converges. The invariant an
      // equivalent prepared revision guarantees is that the in-flight compile
      // still commits - the session leaves the first generation - rather than
      // being superseded back to it the way a non-equivalent revision would.
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== firstGeneration);
      const committedGeneration = session.status().activeVector?.runtimeGenerationId;
      expect(committedGeneration).toEqual(expect.any(String));
      expect(committedGeneration).not.toBe(firstGeneration);
      expect(session.mcpRegistry.snapshot()).toMatchObject({ runtimeGenerationId: committedGeneration });
      expect(session.status()).toMatchObject({
        activeVector: { runtimeGenerationId: committedGeneration },
        diagnostics: [],
        state: 'active',
      });
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('commits an activation while a later compile is still in flight at the commit check', { timeout: 90_000 * timeScale }, async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const observer = interceptCompileObserver();
    const commitReached = deferred<void>();
    const allowCommit = deferred<void>();
    let armCommitBarrier = false;
    const events: Array<{ readonly runtimeGenerationId?: string; readonly type: string }> = [];
    const session = await RsbuildRuntimeSession.start({
      ...startContext({
        projectRoot: copied.projectRoot,
        preparedRuntime: prepared.devRuntime!,
        providerSessionId: 'provider-live-attempt-commit',
        signal: new AbortController().signal,
        storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-live-attempt-commit'),
      }),
      emit: (event) => { events.push(event); },
    }, {
      beforeActivationCommit: async () => {
        if (!armCommitBarrier) return;
        armCommitBarrier = false;
        commitReached.resolve();
        await allowCommit.promise;
      },
      createRsbuild: observer.create,
    });
    try {
      await waitFor(() => session.status().state === 'active');
      const firstGeneration = session.status().activeVector!.runtimeGenerationId;
      armCommitBarrier = true;
      const raceChildren = await stageSyntheticCohort(observer, join(copied.projectRoot, '.agent-bundle', 'runtime-live-attempt-commit'), 'live-race');
      observer.observeCompileStart();
      await observer.completeAttempt({ children: raceChildren });
      await commitReached.promise;
      // The #38 wedge: a later compile starts while the newest completed
      // cohort sits between its final guard wait and the commit check.
      // Pre-compile observation is advisory and owns no identity, so it must
      // neither supersede nor delay the activation - it may still settle as
      // a no-op or a failure, which would leave nothing to activate and no
      // retrigger.
      observer.observeCompileStart();
      allowCommit.resolve();
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== firstGeneration);
      const committed = session.status().activeVector?.runtimeGenerationId;
      expect(committed).toEqual(expect.any(String));
      expect(session.status()).toMatchObject({ diagnostics: [], state: 'active' });
      expect(events.filter((event) => event.type === 'runtime.generation.activated' && event.runtimeGenerationId === committed)).toHaveLength(1);
      await observer.completeAttempt({ hasErrors: true });
      expect(session.status().activeVector?.runtimeGenerationId).toBe(committed);
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('commits an activation after a later broken attempt fails inside the commit window', { timeout: 90_000 * timeScale }, async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const observer = interceptCompileObserver();
    const commitReached = deferred<void>();
    const allowCommit = deferred<void>();
    let armCommitBarrier = false;
    const events: Array<{ readonly runtimeGenerationId?: string; readonly type: string }> = [];
    const session = await RsbuildRuntimeSession.start({
      ...startContext({
        projectRoot: copied.projectRoot,
        preparedRuntime: prepared.devRuntime!,
        providerSessionId: 'provider-failed-attempt-commit',
        signal: new AbortController().signal,
        storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-failed-attempt-commit'),
      }),
      emit: (event) => { events.push(event); },
    }, {
      beforeActivationCommit: async () => {
        if (!armCommitBarrier) return;
        armCommitBarrier = false;
        commitReached.resolve();
        await allowCommit.promise;
      },
      createRsbuild: observer.create,
    });
    try {
      await waitFor(() => session.status().state === 'active');
      const firstGeneration = session.status().activeVector!.runtimeGenerationId;
      armCommitBarrier = true;
      const raceChildren = await stageSyntheticCohort(observer, join(copied.projectRoot, '.agent-bundle', 'runtime-failed-attempt-commit'), 'failed-race');
      observer.observeCompileStart();
      await observer.completeAttempt({ children: raceChildren });
      await commitReached.promise;
      // A later broken compile fails and settles entirely inside the commit
      // window. A failed completed cohort never bumps the cohort ordinal, so
      // it must not supersede the newest successful compile (#38) -
      // discarding it here left the runtime permanently on the stale first
      // generation.
      observer.observeCompileStart();
      await observer.completeAttempt({ hasErrors: true });
      allowCommit.resolve();
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== firstGeneration);
      const committed = session.status().activeVector?.runtimeGenerationId;
      expect(committed).toEqual(expect.any(String));
      expect(session.status()).toMatchObject({ state: 'active' });
      expect(events.filter((event) => event.type === 'runtime.generation.activated' && event.runtimeGenerationId === committed)).toHaveLength(1);
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('activates from unpaired completion callbacks and never wedges behind a dangling pre-compile observation', { timeout: 90_000 * timeScale }, async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const observer = interceptCompileObserver();
    const events: Array<{ readonly type: string }> = [];
    const session = await RsbuildRuntimeSession.start({
      ...startContext({
        projectRoot: copied.projectRoot,
        preparedRuntime: prepared.devRuntime!,
        providerSessionId: 'provider-unpaired-completion',
        signal: new AbortController().signal,
        storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-unpaired-completion'),
      }),
      emit: (event) => { events.push(event); },
    }, { createRsbuild: observer.create });
    try {
      await waitFor(() => session.status().state === 'active');
      const firstGeneration = session.status().activeVector!.runtimeGenerationId;
      // A completion with no paired pre-compile callback (a coalesced or
      // dropped onBeforeDevCompile) is a complete authoritative cohort.
      const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-unpaired-completion');
      const unpairedChildren = await stageSyntheticCohort(observer, storageRoot, 'unpaired');
      await observer.completeAttempt({ children: unpairedChildren });
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== firstGeneration);
      const unpairedGeneration = session.status().activeVector!.runtimeGenerationId;
      expect(session.status()).toMatchObject({ diagnostics: [], state: 'active' });

      // A pre-compile observation whose completion never arrives owns no
      // identity or barrier, so the next completed cohort activates without
      // waiting on it.
      observer.observeCompileStart();
      const postDanglingChildren = await stageSyntheticCohort(observer, storageRoot, 'post-dangling');
      await observer.completeAttempt({ children: postDanglingChildren });
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== unpairedGeneration);
      expect(session.status()).toMatchObject({ diagnostics: [], state: 'active' });

      // Redelivering the same completed MultiStats is an unchanged-cohort
      // no-op under a fresh identity, never a mispair or a failure.
      const committed = session.status().activeVector!.runtimeGenerationId;
      await observer.completeAttempt({ children: postDanglingChildren });
      await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
      expect(session.status().activeVector?.runtimeGenerationId).toBe(committed);
      expect(events.filter((event) => event.type === 'runtime.generation.failed')).toHaveLength(0);
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('fails a wedged activation reconcile within the budget and releases its late reservation', { timeout: 120_000 * timeScale }, async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const wedgeReached = deferred<void>();
    const releaseWedge = deferred<void>();
    let armWedge = false;
    const activationBudgetMs = 4_000;
    const events: Array<{ readonly runtimeGenerationId?: string; readonly type: string }> = [];
    const session = await RsbuildRuntimeSession.start({
      ...startContext({
        projectRoot: copied.projectRoot,
        preparedRuntime: prepared.devRuntime!,
        providerSessionId: 'provider-wedged-reconcile',
        signal: new AbortController().signal,
        storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-wedged-reconcile'),
      }),
      emit: (event) => { events.push(event); },
    }, {
      activationPhaseBudgetMs: activationBudgetMs * timeScale,
      beforeMcpRelist: async () => {
        if (!armWedge) return;
        wedgeReached.resolve();
        await releaseWedge.promise;
      },
    });
    try {
      await waitFor(() => session.status().state === 'active');
      const firstGeneration = session.status().activeVector!.runtimeGenerationId;
      const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
      try {
        armWedge = true;
        await changeDefinition(copied.projectRoot, 'Read state after a wedged activation reconcile.');
        await wedgeReached.promise;
        // A wedged MCP reconcile must become a loud, phase-attributed failure
        // within the scaled budget instead of the silent permanent hang from
        // #38; the page recovers through its failed-event bootstrap path.
        await waitForWithin(
          () => session.status().diagnostics.some((diagnostic) => diagnostic.message.includes('mcp-registry activation step exceeded')),
          activationBudgetMs + 15_000,
        );
        expect(events.some((event) => event.type === 'runtime.generation.failed')).toBe(true);
        expect(session.status().activeVector?.runtimeGenerationId).toBe(firstGeneration);
        // Releasing the wedge lets the abandoned preparation settle late; its
        // registry reservation must be released, or every later activation
        // would wedge behind it.
        armWedge = false;
        releaseWedge.resolve();
        await changeWorkerImplementation(copied.projectRoot, 'post-wedge-activation');
        await waitForWithin(
          () => session.status().activeVector?.runtimeGenerationId !== firstGeneration,
          activationBudgetMs + 15_000,
        );
        expect(session.status().activeVector?.runtimeGenerationId).not.toBe(firstGeneration);
      } finally {
        await mcp.close();
      }
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('retains a leased inactive generation through pruning and prunes it after the read releases', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const enteredRead = deferred<void>();
    const releaseRead = deferred<void>();
    let deferAssetRead = true;
    const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-asset-lease');
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-asset-lease',
      signal: new AbortController().signal,
      storageRoot,
    }), {
      beforeAssetRead: async () => {
        if (!deferAssetRead) return;
        enteredRead.resolve();
        await releaseRead.promise;
      },
    });
    try {
      await waitFor(() => session.status().state === 'active');
      const firstGeneration = session.mcpRegistry.snapshot()!.runtimeGenerationId;
      const heldRead = session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: firstGeneration,
        surfaceId: 'mcp.timeline',
      });
      await enteredRead.promise;
      let activeGeneration = firstGeneration;
      for (let marker = 2; marker <= 7; marker += 1) {
        await changeWorkerImplementation(copied.projectRoot, `lease-prune-${String(marker)}`);
        await waitFor(() => session.status().activeVector?.runtimeGenerationId !== activeGeneration);
        activeGeneration = session.status().activeVector!.runtimeGenerationId;
      }
      expect((await lstat(join(storageRoot, 'generation-store', 'generations', firstGeneration))).isDirectory()).toBe(true);
      releaseRead.resolve();
      await expect(heldRead).resolves.toMatchObject({ contentType: 'text/html' });
      deferAssetRead = false;
      await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: firstGeneration,
        surfaceId: 'mcp.timeline',
      })).resolves.toBeUndefined();
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 60_000 * timeScale);

test('aborts a deferred Rsbuild creation before starting its dev server', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const controller = new AbortController();
    const reason = new Error('deferred compiler creation aborted');
    const created = deferred<Awaited<ReturnType<typeof createRsbuild>>>();
    let createCalls = 0;
    let devServerStarts = 0;
    const starting = RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-late-compiler',
      signal: controller.signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-late-compiler'),
    }), {
      createRsbuild: (async () => {
        createCalls += 1;
        return created.promise;
      }) as typeof createRsbuild,
    });
    await waitFor(() => createCalls === 1);
    controller.abort(reason);
    created.resolve(Object.freeze({
      startDevServer: async () => {
        devServerStarts += 1;
        throw new Error('The aborted provider must not start a dev server.');
      },
    }) as unknown as Awaited<ReturnType<typeof createRsbuild>>);

    await expect(starting).rejects.toBe(reason);
    expect(devServerStarts).toBe(0);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('returns a compiling session without treating provider activation work as a startup barrier', async () => {
  const copied = await copyProviderExample();
  const activationReached = deferred<void>();
  const releaseActivation = deferred<void>();
  let session: RsbuildRuntimeSession | undefined;
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const starting = RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-compiling-startup',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-compiling-startup'),
    }), {
      afterActivationPrepare: async (input) => {
        if (input.phase !== 'store') return;
        activationReached.resolve();
        await releaseActivation.promise;
      },
    });
    let returnedSession: RsbuildRuntimeSession | undefined;
    void starting.then((started) => { returnedSession = started; });
    await activationReached.promise;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const returnedBeforeActivation = returnedSession;
    expect(returnedBeforeActivation?.status()).toMatchObject({ state: 'compiling' });
    if (returnedBeforeActivation === undefined) throw new Error('RSC runtime session did not return while compiling.');
    const originalApp = prepared.devRuntime!.apps[0]!;
    const reconciling = returnedBeforeActivation.reconcilePreparedRuntime({
      ...prepared.devRuntime!,
      apps: [{ ...originalApp, name: 'timeline-startup' }],
      sourceRevision: `${prepared.devRuntime!.sourceRevision}-startup-reconcile`,
    });
    releaseActivation.resolve();
    session = await starting;

    await reconciling;
    await waitFor(() => session?.status().state === 'active');
    await expect(session.readAsset({
      path: ['rsc', 'index.html'],
      runtimeGenerationId: session.status().activeVector!.runtimeGenerationId,
      surfaceId: 'mcp.timeline-startup',
    })).resolves.toMatchObject({ contentType: 'text/html' });
  } finally {
    releaseActivation.resolve();
    await session?.close();
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 60_000);

test('uses the bound Rsbuild dev-server context instead of a stale port-zero start result', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    let closeCalls = 0;
    const create = async (input: Readonly<{ readonly config: unknown }>) => {
      const plugin = ((input.config as Readonly<{ readonly plugins?: readonly unknown[] }>).plugins ?? []).find((candidate): candidate is Readonly<{
        readonly name: string;
        setup(api: unknown): void;
      }> => typeof candidate === 'object' && candidate !== null &&
        (candidate as { readonly name?: unknown }).name === 'agent-bundle:rsc-runtime-app-reload');
      if (plugin === undefined) throw new Error('RSC App reload plugin is unavailable.');
      let afterCreate: ((input: unknown) => void) | undefined;
      plugin.setup({
        onAfterCreateCompiler: (callback: unknown) => { afterCreate = callback as (input: unknown) => void; },
        onAfterEnvironmentCompile: () => undefined,
        onBeforeStartDevServer: () => undefined,
        onCloseDevServer: () => undefined,
      });
      afterCreate?.({ environments: { app: {} } });
      return Object.freeze({
        context: Object.freeze({
          devServer: Object.freeze({ hostname: '127.0.0.1', https: false, port: 41_103 }),
        }),
        startDevServer: async () => Object.freeze({
          port: 0,
          server: Object.freeze({ close: async () => { closeCalls += 1; } }),
          urls: Object.freeze(['http://127.0.0.1:0']),
        }) as unknown as StartDevServerResult,
      }) as unknown as Awaited<ReturnType<typeof createRsbuild>>;
    };
    const session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-bound-dev-server-context',
      signal: new AbortController().signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-bound-dev-server-context'),
    }), { createRsbuild: create as typeof createRsbuild });
    try {
      expect(session.clientSurface('mcp.edit-timeline')).toMatchObject({
        httpOrigin: 'http://127.0.0.1:41103',
        subscribeReload: expect.any(Function),
      });
    } finally {
      await session.close();
    }
    expect(closeCalls).toBe(1);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('waits for a late Rsbuild server closer after aborting startup', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const controller = new AbortController();
    const reason = new Error('late server startup aborted');
    const started = deferred<StartDevServerResult>();
    const closeGate = deferred<void>();
    let createCalls = 0;
    let closeCalls = 0;
    const create = async () => {
      createCalls += 1;
      return Object.freeze({ startDevServer: async () => started.promise }) as unknown as Awaited<ReturnType<typeof createRsbuild>>;
    };
    const starting = RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-late-server',
      signal: controller.signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-late-server'),
    }), { createRsbuild: create as typeof createRsbuild });

    await waitFor(() => createCalls === 1);
    controller.abort(reason);
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    started.resolve(Object.freeze({
      port: 41_001,
      server: Object.freeze({ close: async () => {
        closeCalls += 1;
        await closeGate.promise;
      } }),
      urls: Object.freeze(['http://127.0.0.1:41001']),
    }) as unknown as StartDevServerResult);

    const outcome = starting.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    let settled = false;
    void outcome.then(() => { settled = true; });
    await waitFor(() => closeCalls === 1);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const settledBeforeCloseFinished = settled;
    closeGate.resolve();
    await expect(outcome).resolves.toBe(reason);
    expect(settledBeforeCloseFinished).toBe(false);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('closes a server returned immediately after startup abort', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const controller = new AbortController();
    const reason = new Error('returned server startup aborted');
    let closeCalls = 0;
    const create = async () => Object.freeze({
      startDevServer: async () => {
        controller.abort(reason);
        return Object.freeze({
          port: 41_002,
          server: Object.freeze({ close: async () => { closeCalls += 1; } }),
          urls: Object.freeze(['http://127.0.0.1:41002']),
        }) as unknown as StartDevServerResult;
      },
    }) as unknown as Awaited<ReturnType<typeof createRsbuild>>;

    await expect(RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-returned-server',
      signal: controller.signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-returned-server'),
    }), { createRsbuild: create as typeof createRsbuild })).rejects.toBe(reason);
    expect(closeCalls).toBe(1);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('preserves an aborted startup cause with every acquired cleanup failure', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const controller = new AbortController();
    const reason = new Error('startup aborted after acquiring the dev server');
    const cleanupSecret = 'do-not-expose-startup-cleanup-secret';
    const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-startup-cleanup-failure');
    let serverCloseCalls = 0;
    const create = async () => Object.freeze({
      startDevServer: async () => {
        await writeFile(join(storageRoot, 'runs', '.agent-bundle-runtime-owner'), 'tampered-owner-marker');
        controller.abort(reason);
        return Object.freeze({
          port: 41_003,
          server: Object.freeze({ close: async () => {
            serverCloseCalls += 1;
            throw new Error(cleanupSecret);
          } }),
          urls: Object.freeze(['http://127.0.0.1:41003']),
        }) as unknown as StartDevServerResult;
      },
    }) as unknown as Awaited<ReturnType<typeof createRsbuild>>;

    const outcome = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-startup-cleanup-failure',
      signal: controller.signal,
      storageRoot,
    }), { createRsbuild: create as typeof createRsbuild }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(serverCloseCalls).toBe(1);
    expect(outcome).toBeInstanceOf(AggregateError);
    const failure = outcome as AggregateError;
    expect(failure.message).toBe('RSC runtime startup failed; cleanup failures: owned-runs-root, rsbuild-dev-server.');
    expect(failure.message).not.toContain(cleanupSecret);
    expect(failure.errors[0]).toBe(reason);
    expect(failure.errors).toEqual(expect.arrayContaining([
      reason,
      expect.objectContaining({ message: cleanupSecret }),
      expect.objectContaining({ message: 'RSC runtime invocation root ownership marker changed during this provider session.' }),
    ]));
    expect((await lstat(join(storageRoot, 'runs'))).isDirectory()).toBe(true);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('joins a late owned-runs cleanup after abort has already drained startup cleanup', async () => {
  const copied = await copyProviderExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const controller = new AbortController();
    const reason = new Error('startup aborted while acquiring owned runs root');
    const cleanupSecret = 'do-not-expose-late-owned-runs-secret';
    const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-late-owned-runs-root');
    const ownedRunsRootCreated = deferred<void>();
    const releaseOwnedRunsRoot = deferred<void>();
    const startupCleanupClosed = deferred<void>();
    const ownedRunsCleanupEntered = deferred<void>();
    const releaseOwnedRunsCleanup = deferred<void>();
    let settled = false;
    const starting = RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-late-owned-runs-root',
      signal: controller.signal,
      storageRoot,
    }), {
      afterOwnedRunsRootCreated: async () => {
        ownedRunsRootCreated.resolve();
        await releaseOwnedRunsRoot.promise;
      },
      beforeOwnedRunsRootCleanup: async () => {
        ownedRunsCleanupEntered.resolve();
        await releaseOwnedRunsCleanup.promise;
        await writeFile(join(storageRoot, 'runs', '.agent-bundle-runtime-owner'), cleanupSecret);
      },
      onStartupCleanupClosed: () => { startupCleanupClosed.resolve(); },
    });
    const outcome = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    void outcome.then(() => { settled = true; });

    await ownedRunsRootCreated.promise;
    controller.abort(reason);
    await startupCleanupClosed.promise;
    releaseOwnedRunsRoot.resolve();
    await ownedRunsCleanupEntered.promise;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(settled).toBe(false);
    releaseOwnedRunsCleanup.resolve();

    const failure = await outcome;
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe('RSC runtime startup failed; cleanup failures: owned-runs-root.');
    expect(aggregate.message).not.toContain(cleanupSecret);
    expect(aggregate.errors[0]).toBe(reason);
    expect(aggregate.errors).toEqual(expect.arrayContaining([
      reason,
      expect.objectContaining({ message: 'RSC runtime invocation root ownership marker changed during this provider session.' }),
    ]));
    expect((await lstat(join(storageRoot, 'runs'))).isDirectory()).toBe(true);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});

test('drains every live-session cleanup group once when independent closers reject', async () => {
  const copied = await copyProviderExample();
  const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-live-close-failures');
  const attempted: string[] = [];
  const secrets = new Map([
    ['owned-runs-root', 'do-not-expose-live-root-secret'],
    ['rsbuild-dev-server', 'do-not-expose-live-server-secret'],
    ['run-artifact', 'do-not-expose-live-artifact-secret'],
  ]);
  let session: RsbuildRuntimeSession | undefined;
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    session = await RsbuildRuntimeSession.start(startContext({
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-live-close-failures',
      signal: new AbortController().signal,
      storageRoot,
    }), {
      afterLiveSessionCleanupResource: ({ resource }: Readonly<{ readonly resource: string }>) => {
        attempted.push(resource);
        const secret = secrets.get(resource);
        if (secret !== undefined) throw new Error(secret);
      },
    });
    await waitFor(() => session!.status().state === 'active');
    const activeVector = session.status().activeVector;
    if (activeVector === undefined) throw new Error('Expected an active runtime generation.');
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    await expect(session.invoke({
      expectedGenerationId: activeVector.runtimeGenerationId,
      input: {},
      surfaceId: 'mcp.runtime_status',
      target,
    })).resolves.toMatchObject({ status: 'succeeded' });

    const closing = session.close();
    expect(session.close()).toBe(closing);
    const failure = await closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe('RSC runtime session close failed; cleanup failures: owned-runs-root, rsbuild-dev-server, run-artifact.');
    for (const secret of secrets.values()) expect(aggregate.message).not.toContain(secret);
    expect(aggregate.errors).toEqual(expect.arrayContaining([...secrets.values()].map((secret) => expect.objectContaining({ message: secret }))));
    expect(attempted).toEqual(expect.arrayContaining([
      'generation-store',
      'owned-runs-root',
      'rsbuild-dev-server',
      'run-artifact',
      'runtime-mcp-registry',
    ]));
    expect(new Set(attempted).size).toBe(attempted.length);
    expect(session.close()).toBe(closing);
  } finally {
    await session?.close().catch(() => undefined);
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 45_000 * timeScale);
